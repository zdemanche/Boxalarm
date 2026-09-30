import NetInfo from '@react-native-community/netinfo';
import { ApiError, apiRequest, type AuthTokenSource } from '../lib/apiClient';
import type { SyncQueueStatus } from '../features/sync/types';
import { kvGet } from './kvStore';
import { LAST_SESSION_SUB_KEY } from './memberCache';
import * as outbox from './outbox';
import type { OutboxKind, OutboxRow } from './outbox';

type Listener = (status: SyncQueueStatus) => void;

let tokens: AuthTokenSource | null = null;
let apiBaseUrl: string | null = null;
let draining = false;
// Set when drain() is called while one is already running, so the running drain loops once more
// instead of silently skipping an entry enqueued after it listed the outbox.
let drainRequested = false;
let unsubscribeNetInfo: (() => void) | null = null;
// Set once the startup reconciliation of stranded SYNCING rows has run for this process.
let recoveredOrphans = false;
let lastSyncAt: string | null = null;
const listeners = new Set<Listener>();
// Ids this process delivered, so a screen can tell "sent" apart from "discarded" once a row
// leaves the outbox. Bounded: only the screen that queued an item asks, shortly afterwards.
const recentlySynced = new Set<string>();
const RECENTLY_SYNCED_LIMIT = 50;

/** Whether a token source is set - false in a headless JS task until one is configured. */
export function isConfigured(): boolean {
  return tokens !== null && apiBaseUrl !== null;
}

export function hasSynced(id: string): boolean {
  return recentlySynced.has(id);
}

function rememberSynced(id: string): void {
  recentlySynced.add(id);
  if (recentlySynced.size > RECENTLY_SYNCED_LIMIT) {
    const oldest = recentlySynced.values().next().value;
    if (oldest !== undefined) recentlySynced.delete(oldest);
  }
}

// Called on every auth/config change (useSyncEngine, mounted once at the app root). While signed in, a NetInfo
// listener drains on reconnect; on sign-out it is removed so repeated login/logout cycles never
// stack listeners. Entries queued while signed out are drained as soon as tokens arrive.
/**
 * Whose work this phone is queueing and sending (R2-M3). Read from the signed-in session the
 * token source belongs to (AuthContext's value carries memberId/deptId). Every row is stamped with
 * it at enqueue, and only rows stamped with the signed-in member are sent: member B signing in on
 * a station phone never sends member A's attendance, checks or mark-offs under B's token.
 */
interface Owner {
  readonly memberId: string | null;
  readonly deptId: string | null;
}

let owner: Owner = { memberId: null, deptId: null };

/** Looks up the stored session's member when no configured session carries one (R3-C1). */
let ownerResolver: (() => Promise<{ memberId: string; deptId: string | null } | null>) | null =
  null;

export function setOwnerResolver(resolver: typeof ownerResolver): void {
  ownerResolver = resolver;
}

/**
 * How the alert layer takes part in dropping stale ownerless answers: when the page says the call
 * happened, and what to tell the member once their unsent answer is dropped. Registered by
 * notificationActions so this module needs no knowledge of notifications or payloads.
 */
export interface StaleAnswerHooks {
  pageTime(dispatchId: string): Promise<number | null>;
  onDropped(dispatchId: string): Promise<void>;
}

let staleAnswerHooks: StaleAnswerHooks | null = null;

export function setStaleAnswerHooks(hooks: StaleAnswerHooks | null): void {
  staleAnswerHooks = hooks;
}

async function dropStaleOwnerlessAnswers(): Promise<void> {
  const hooks = staleAnswerHooks;
  const dropped = await outbox.discardStaleOwnerlessResponses(Date.now(), async (row) => {
    const dispatchId = outbox.responseDispatchId(row);
    return dispatchId && hooks ? hooks.pageTime(dispatchId) : null;
  });
  for (const row of dropped) {
    const dispatchId = outbox.responseDispatchId(row);
    if (dispatchId && hooks) await hooks.onDropped(dispatchId).catch(() => undefined);
  }
}

function ownerOf(source: AuthTokenSource): Owner {
  const session = source as AuthTokenSource & { memberId?: unknown; deptId?: unknown };
  return {
    memberId:
      typeof session.memberId === 'string' && session.memberId.length > 0 ? session.memberId : null,
    deptId: typeof session.deptId === 'string' ? session.deptId : null,
  };
}

/** The member whose rows may be sent and shown right now; null while signed out. */
function signedInMember(): string | null {
  return tokens ? owner.memberId : null;
}

/** A token source that may also say whose session it is (AuthContext's value, the headless
 * stored-session source). */
export type SessionTokenSource = AuthTokenSource & {
  readonly memberId?: string | null;
  readonly deptId?: string | null;
};

export function configure(
  nextTokens: SessionTokenSource | null,
  nextApiBaseUrl: string | null,
): void {
  tokens = nextTokens;
  apiBaseUrl = nextApiBaseUrl;
  // Signed out: no configured owner. Anything queued without a session (the headless answer
  // task) resolves its owner from the stored session instead (R3-C1).
  owner = nextTokens ? ownerOf(nextTokens) : { memberId: null, deptId: null };
  void notify();
  if (tokens && apiBaseUrl) {
    unsubscribeNetInfo ??= NetInfo.addEventListener((state) => {
      if (state.isConnected === true) void drain();
    });
    void drain();
  } else if (unsubscribeNetInfo) {
    unsubscribeNetInfo();
    unsubscribeNetInfo = null;
  }
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  void notify();
  return () => {
    listeners.delete(listener);
  };
}

async function notify(): Promise<void> {
  await dropStaleOwnerlessAnswers();
  // The current (or last signed-in) member's view; nothing is sent without a signed-in session.
  const status = await outbox.getStatus(lastSyncAt, owner.memberId, Date.now());
  listeners.forEach((listener) => listener(status));
}

function unitPath(unitId: string, suffix: string): string {
  return `apparatus/${encodeURIComponent(unitId)}/${suffix}`;
}

/**
 * The owner stamped on a new row. Never blank (R3-C1): the configured session's member, else the
 * stored session's (headless task, cold start), else NULL - which is adoptable, and for an alert
 * answer sent automatically by the next signed-in member within the answer window.
 */
async function ownerStamp(): Promise<{
  ownerMemberId: string | null;
  ownerDeptId: string | null;
  answeredAsHint?: string | null;
}> {
  if (owner.memberId) return { ownerMemberId: owner.memberId, ownerDeptId: owner.deptId };
  const resolved = ownerResolver ? await ownerResolver().catch(() => null) : null;
  if (resolved) return { ownerMemberId: resolved.memberId, ownerDeptId: resolved.deptId };
  // Ownerless (a keychain read failure): record which member's session the phone last had, so
  // only that member's sign-in can auto-send it (R4-M1). Cleared on sign-out, so a signed-out
  // phone records nothing.
  const hint = await kvGet<string>(LAST_SESSION_SUB_KEY);
  return { ownerMemberId: null, ownerDeptId: null, answeredAsHint: hint?.value ?? null };
}

async function enqueueAndDrain(
  kind: OutboxKind,
  id: string,
  label: string,
  path: string,
  body: Record<string, unknown>,
  photoLocalUri?: string,
): Promise<void> {
  await outbox.enqueue({ id, kind, label, path, body, photoLocalUri, ...(await ownerStamp()) });
  await notify();
  void drain();
}

export async function enqueueChecklistRun(
  unitId: string,
  idempotencyKey: string,
  body: Record<string, unknown>,
): Promise<void> {
  await enqueueAndDrain(
    'CHECKLIST_RUN',
    idempotencyKey,
    `Truck check — ${unitId}`,
    unitPath(unitId, 'checks'),
    body,
  );
}

export async function enqueueDefect(
  unitId: string,
  idempotencyKey: string,
  body: Record<string, unknown>,
  photoLocalUri?: string,
): Promise<void> {
  await enqueueAndDrain(
    'DEFECT',
    idempotencyKey,
    `Defect report — ${unitId}`,
    unitPath(unitId, 'defects'),
    body,
    photoLocalUri,
  );
}

// POST /api/v1/inspections/field-capture (inspections-service fieldCapture/handler.ts). The body
// carries its own idempotencyKey, so a replay after a lost response is answered 200 "duplicate"
// with the original inspection and freshly signed photo upload URLs.
export async function enqueueFieldCapture(
  idempotencyKey: string,
  occupancyId: string,
  body: Record<string, unknown>,
  photoLocalUri?: string,
): Promise<void> {
  await enqueueAndDrain(
    'FIELD_CAPTURE',
    idempotencyKey,
    `Field capture — ${occupancyId}`,
    'inspections/field-capture',
    body,
    photoLocalUri,
  );
}

// POST /api/v1/personnel/attendance (personnel-service attendance/handler.ts). The record's key
// is the member plus occurredAt, and the handler answers a repeat of that key with 409, so the
// natural key doubles as the outbox id and a 409 on replay means "already recorded".
// POST /api/v1/personnel/members/{memberId}/availability (personnel-service availability/handler.ts).
// Unlike attendance, a 409 here is NOT "delivered": the handler keys a mark-off on member +
// startAt only, so a 409 can mean a different window already holds that start, and counting it
// as success told a member paging resumed at 06:00 while the server kept a week (review M1). The
// id covers the whole window, and a newer mark-off drops any older one still waiting to send, so
// a correction made before sync is the one that goes out. Returns how many older unsent
// mark-offs it replaced.
export async function enqueueAvailability(
  idempotencyKey: string,
  memberId: string,
  label: string,
  body: Record<string, unknown>,
): Promise<{ replaced: number; mayStand: number }> {
  if (!memberId) throw new Error('A mark-off needs the signed-in member');
  const path = `personnel/members/${encodeURIComponent(memberId)}/availability`;
  // The mark-off names its member in the path, so that member owns it.
  const stamp = await ownerStamp();
  const row = await outbox.enqueue({
    id: idempotencyKey,
    kind: 'AVAILABILITY',
    label,
    path,
    body,
    ownerMemberId: memberId,
    ownerDeptId: stamp.ownerMemberId === memberId ? stamp.ownerDeptId : null,
  });
  // Only a row that was never sent can be dropped: one that was attempted may have reached the
  // server with its response lost, so it stays, and the member is told both may stand (R2-M1).
  let replaced = 0;
  let mayStand = 0;
  for (const sibling of await outbox.olderSiblings(row)) {
    if (await outbox.discardIfUnattempted(sibling.id)) replaced += 1;
    else mayStand += 1;
  }
  await notify();
  void drain();
  return { replaced, mayStand };
}

/** lastError of an AVAILABILITY row the server answered 409 on its first attempt. */
export const AVAILABILITY_CONFLICT =
  'Not recorded: the server already has a mark-off starting at this exact time.';

/**
 * lastError of an AVAILABILITY row answered 409 on a retry. The start carries this phone's own
 * seconds, so that is almost always this row's earlier send landing with its response lost: the
 * member is probably marked off, and must not be told they will still be alerted (R2-M1).
 */
export const AVAILABILITY_MAY_BE_IN_EFFECT =
  'This may already be in effect: an earlier send may have reached Boxalarm before the connection dropped. Ask an officer to check.';

export async function enqueueAttendance(
  idempotencyKey: string,
  label: string,
  body: Record<string, unknown>,
): Promise<void> {
  await enqueueAndDrain('ATTENDANCE', idempotencyKey, label, 'personnel/attendance', body);
}

// POST /api/v1/alerting/dispatches/{dispatchId}/responses (alerting-service responses/handler.ts).
// Each answer is its own row (a changed answer is a new append-only answer, not an edit), and a
// newer answer drops any older one for the same call that has not started sending, so a retried
// "Responding" can never land after the member changed it to "Not responding". The body carries
// clientAnswerId + answeredAtMs: the server orders answers by answeredAtMs, answers a replay of
// the same clientAnswerId with the original result (a lost 200 retried is still "Sent"), and
// answers 409 when the answer was recorded but is not the one on the roster - code SUPERSEDED (a
// newer answer, perhaps from another device, is current) or another code (not recorded).
// A server without that change can still drop a same-second change while answering 200, which is
// why the screen re-reads the roster after delivery (useAlertResponse).
export async function enqueueResponse(
  id: string,
  dispatchId: string,
  label: string,
  body: Record<string, unknown>,
): Promise<void> {
  const path = `alerting/dispatches/${encodeURIComponent(dispatchId)}/responses`;
  const row = await outbox.enqueue({
    id,
    kind: 'RESPONSE',
    label,
    path,
    body,
    ...(await ownerStamp()),
  });
  const older = await outbox.olderSiblings(row);
  await Promise.all(
    older
      .filter((sibling) => sibling.status !== 'SYNCING')
      .map((sibling) => outbox.discard(sibling.id)),
  );
  await notify();
  void drain();
}

/** Unsent rows the member queued: what signing out would leave waiting on this phone. */
export async function countUnsentFor(memberId: string): Promise<number> {
  return outbox.countUnsentFor(memberId);
}

/** The member chose to discard their unsent work at sign-out. */
export async function discardAllFor(memberId: string): Promise<void> {
  await outbox.discardAllFor(memberId);
  await notify();
}

/**
 * A row queued before this phone recorded owners: the signed-in member explicitly says it is
 * theirs, and only then is it sent under their session.
 */
export async function sendAsMe(id: string): Promise<void> {
  const memberId = signedInMember();
  if (!memberId) return;
  await outbox.adopt(id, memberId, owner.deptId);
  await notify();
  void drain();
}

export async function retry(id: string): Promise<void> {
  await outbox.retry(id);
  await notify();
  void drain();
}

export async function discard(id: string): Promise<void> {
  await outbox.discard(id);
  await notify();
}

// A signed photo URL is short-lived (an S3 presigned PUT, 10 min) - shorter than a phone can
// easily spend without signal between the create and the upload. Both photo-carrying creates
// answer an idempotent replay with a freshly signed link for the stored photo (field capture's
// photoUploadUrls, the defect's uploadUrl), so an expired link is recovered by replaying the
// POST rather than losing the photo. A kind added here later without that server support
// would be rejected with a clear reason instead of retried forever.
const RESIGNS_ON_REPLAY: ReadonlySet<OutboxKind> = new Set(['FIELD_CAPTURE', 'DEFECT']);

/**
 * lastError of a RESPONSE row answered 409 with any code but SUPERSEDED (e.g. ANSWER_ID_REUSED):
 * the answer is not on the roster. Terminal: the member sends it again as a new answer (new
 * clientAnswerId and answeredAtMs), which the UI offers.
 */
export const RESPONSE_NOT_RECORDED = "Not recorded on the officer's roster";

/**
 * lastError of a RESPONSE row answered 409 code SUPERSEDED: recorded, but a newer answer (maybe
 * from another of the member's devices) is the one on the roster. Terminal; the UI shows the
 * roster's answer and offers "send mine again" or "keep".
 */
export const RESPONSE_SUPERSEDED = 'A newer answer is already on the roster';

class AvailabilityConflictError extends Error {
  constructor(retry: boolean) {
    super(retry ? AVAILABILITY_MAY_BE_IN_EFFECT : AVAILABILITY_CONFLICT);
  }
}

class ResponseNotCurrentError extends Error {
  constructor(message: string) {
    super(message);
  }
}

class PhotoUploadUrlExpiredError extends Error {
  constructor(kind: OutboxKind) {
    super(
      RESIGNS_ON_REPLAY.has(kind)
        ? 'Photo upload was refused - retry to request a new upload link'
        : 'Photo upload link expired - the report was saved without its photo',
    );
  }
}

function isExpired(url: string): boolean {
  const expiresAtMs = signedUrlExpiresAtMs(url);
  return expiresAtMs !== null && Date.now() >= expiresAtMs;
}

// S3 SigV4 presigned URLs carry X-Amz-Date (YYYYMMDDTHHMMSSZ) and X-Amz-Expires (seconds).
export function signedUrlExpiresAtMs(url: string): number | null {
  const date = /[?&]X-Amz-Date=(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(url);
  const expires = /[?&]X-Amz-Expires=(\d+)/.exec(url);
  if (!date || !expires) return null;
  const [, y, mo, d, h, mi, sec] = date.map(Number) as number[];
  return Date.UTC(y!, mo! - 1, d!, h!, mi!, sec!) + Number(expires[1]) * 1000;
}

// A 4xx means the server refused this request as sent, so an identical retry cannot succeed -
// except 408 (timeout) and 429 (throttled), which are transient. 401 never reaches here as
// permanent in practice: apiRequest already renewed the token once, and a still-expired session
// is recoverable by signing in again, so it is treated as transient too.
function isPermanentRejection(error: unknown): boolean {
  if (error instanceof PhotoUploadUrlExpiredError) return true;
  if (error instanceof ResponseNotCurrentError) return true;
  if (error instanceof AvailabilityConflictError) return true;
  if (!(error instanceof ApiError)) return false;
  const { status } = error.problem;
  return status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429;
}

/**
 * lastError of a row the server answered 401 even after a silent renewal. Still retried (a
 * session can recover), but it is not "no signal" and must not be worded as such (review m9).
 */
export const SIGN_IN_REJECTED = "The server did not accept this phone's sign-in";

function describeError(error: unknown): string {
  if (error instanceof ApiError && error.problem.status === 401) return SIGN_IN_REJECTED;
  if (error instanceof ApiError) return error.problem.detail ?? error.problem.title;
  return error instanceof Error ? error.message : String(error);
}

// The upload URL is signed over Content-Type (review minor 11): the server signs the type its
// allowlist maps the object key's extension to, so the PUT must send exactly that or S3
// answers 403 - which this outbox would read as an expired URL and re-sign forever. The key
// is the URL's path, so the type is derived from it with the server's own mapping
// (backend inspections-service/assetsSigner.ts UPLOAD_CONTENT_TYPES), not from the local
// file URI, whose extension can differ.
const UPLOAD_CONTENT_TYPES: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  tif: 'image/tiff',
  tiff: 'image/tiff',
};

function extensionOf(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : undefined;
}

export function signedPhotoContentType(uploadUrl: string, localUri: string): string {
  let keyPath: string;
  try {
    keyPath = decodeURIComponent(new URL(uploadUrl).pathname);
  } catch {
    keyPath = '';
  }
  const fromKey = extensionOf(keyPath);
  const fromLocal = extensionOf(localUri);
  return (
    (fromKey && UPLOAD_CONTENT_TYPES[fromKey]) ??
    (fromLocal && UPLOAD_CONTENT_TYPES[fromLocal]) ??
    'image/jpeg'
  );
}

async function uploadPhoto(row: OutboxRow): Promise<void> {
  if (!row.photoLocalUri || !row.photoUploadUrl) return;
  if (isExpired(row.photoUploadUrl)) throw new PhotoUploadUrlExpiredError(row.kind);
  const fileResponse = await fetch(row.photoLocalUri);
  const blob = await fileResponse.blob();
  const uploadResponse = await fetch(row.photoUploadUrl, {
    method: 'PUT',
    body: blob,
    headers: { 'Content-Type': signedPhotoContentType(row.photoUploadUrl, row.photoLocalUri) },
  });
  // S3 answers an expired or otherwise invalid signature with 403.
  if (uploadResponse.status === 403) throw new PhotoUploadUrlExpiredError(row.kind);
  if (!uploadResponse.ok) {
    throw new Error(`Photo upload failed with status ${uploadResponse.status}`);
  }
}

interface UploadTarget {
  readonly uploadUrl: string | null;
  readonly photoS3Key: string | null;
}

// Each create endpoint names its photo upload URL differently: the defect POST returns a single
// { uploadUrl, photoS3Key }; field capture returns photoUploadUrls: [{ filename, uploadUrl }] for
// the photoFilenames it was sent (the outbox row carries one photo, the first filename).
function readUploadTarget(row: OutboxRow, parsed: Record<string, unknown>): UploadTarget {
  if (row.kind === 'FIELD_CAPTURE') {
    const sent = (JSON.parse(row.body) as { photoFilenames?: string[] }).photoFilenames?.[0];
    const urls = Array.isArray(parsed.photoUploadUrls)
      ? (parsed.photoUploadUrls as { filename?: unknown; uploadUrl?: unknown }[])
      : [];
    const match = urls.find((entry) => entry.filename === sent);
    const inspection = parsed.inspection as { photoS3Keys?: unknown } | undefined;
    const keys = Array.isArray(inspection?.photoS3Keys) ? (inspection.photoS3Keys as string[]) : [];
    return {
      uploadUrl: typeof match?.uploadUrl === 'string' ? match.uploadUrl : null,
      photoS3Key: (sent && keys.find((key) => key.endsWith(`/${sent}`))) || null,
    };
  }
  return {
    uploadUrl: typeof parsed.uploadUrl === 'string' ? parsed.uploadUrl : null,
    photoS3Key: typeof parsed.photoS3Key === 'string' ? parsed.photoS3Key : null,
  };
}

// Kinds whose create endpoint has no idempotency key and instead answers a replay of an
// already-stored natural key with 409 - for them a 409 means the first attempt landed (its
// response was lost), so the entry is delivered, not refused.
const CONFLICT_MEANS_DELIVERED: ReadonlySet<OutboxKind> = new Set(['ATTENDANCE']);

/**
 * Minutes of the placeholder ETA sent only to a server that still requires one (see
 * missingEtaFallback). The phone never shows it: the member's answer reads "ETA ?".
 */
export const RESPONSE_PLACEHOLDER_ETA_MINUTES = 10;

function mentionsEta(error: ApiError): boolean {
  const text = `${error.problem.detail ?? ''} ${error.problem.title ?? ''}`;
  return /\beta\b/i.test(text);
}

/**
 * An answer with no ETA is sent as `eta: null` (the post-page-chain server accepts it). A server
 * that still requires an ETA answers 400 naming `eta`; the answer is then re-sent ONCE with a
 * placeholder, flagged etaSource NOT_GIVEN, and the queued body is replaced so a later retry does
 * not repeat the 400. Returns the fallback body, or null when this 400 is not that case.
 */
function missingEtaFallback(row: OutboxRow, error: unknown): string | null {
  if (row.kind !== 'RESPONSE' || !(error instanceof ApiError)) return null;
  if (error.problem.status !== 400 || !mentionsEta(error)) return null;
  const body = JSON.parse(row.body) as Record<string, unknown>;
  if (body.eta !== null || body.ackStatus === 'NOT_RESPONDING') return null;
  const answeredAtMs = typeof body.answeredAtMs === 'number' ? body.answeredAtMs : Date.now();
  return JSON.stringify({
    ...body,
    eta: Math.floor(answeredAtMs / 1000) + RESPONSE_PLACEHOLDER_ETA_MINUTES * 60,
    etaSource: 'NOT_GIVEN',
  });
}

/** The session one drain run sends with, fixed when the run starts (R5-M1). */
interface RunSession {
  readonly tokens: AuthTokenSource;
  readonly apiBaseUrl: string;
}

async function post(row: OutboxRow, session: RunSession): Promise<Response | null> {
  try {
    return await postOnce(row, session);
  } catch (error) {
    const fallbackBody = missingEtaFallback(row, error);
    if (!fallbackBody) throw error;
    await outbox.replaceBody(row.id, fallbackBody);
    return postOnce({ ...row, body: fallbackBody }, session);
  }
}

async function postOnce(row: OutboxRow, session: RunSession): Promise<Response | null> {
  // Never the module-level session: it can change to another member mid-drain (R5-M1).
  const { tokens: runTokens, apiBaseUrl: runApiBaseUrl } = session;
  try {
    return await apiRequest(row.path, runTokens, {
      apiBaseUrl: runApiBaseUrl,
      method: row.method,
      headers: { 'Content-Type': 'application/json' },
      body: row.body,
    });
  } catch (error) {
    if (row.kind === 'RESPONSE' && error instanceof ApiError && error.problem.status === 409) {
      const { code } = error.problem as { code?: unknown };
      throw new ResponseNotCurrentError(
        code === 'SUPERSEDED' ? RESPONSE_SUPERSEDED : RESPONSE_NOT_RECORDED,
      );
    }
    if (row.kind === 'AVAILABILITY' && error instanceof ApiError && error.problem.status === 409) {
      throw new AvailabilityConflictError(row.attempts > 0);
    }
    if (
      CONFLICT_MEANS_DELIVERED.has(row.kind) &&
      error instanceof ApiError &&
      error.problem.status === 409
    ) {
      return null;
    }
    throw error;
  }
}

async function create(row: OutboxRow, session: RunSession): Promise<OutboxRow | undefined> {
  const response = await post(row, session);
  if (!response) {
    await outbox.advanceStage(row.id, { stage: 'DONE' });
    return outbox.find(row.id);
  }
  const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const target = readUploadTarget(row, parsed);
  await outbox.advanceStage(row.id, {
    stage: target.uploadUrl && row.photoLocalUri ? 'UPLOAD_PHOTO' : 'DONE',
    photoUploadUrl: target.uploadUrl,
    photoS3Key: target.photoS3Key,
  });
  return outbox.find(row.id);
}

async function processEntry(id: string, session: RunSession): Promise<void> {
  let row = await outbox.find(id);
  if (!row) return;

  if (row.stage === 'CREATE') {
    row = await create(row, session);
    if (!row) return;
  }

  if (row.stage === 'UPLOAD_PHOTO') {
    // A kind whose replay re-signs gets a fresh link instead of a doomed PUT. The replay is safe:
    // the body's idempotencyKey makes the server answer "duplicate" without writing twice.
    if (row.photoUploadUrl && isExpired(row.photoUploadUrl) && RESIGNS_ON_REPLAY.has(row.kind)) {
      row = await create(row, session);
      if (!row || row.stage !== 'UPLOAD_PHOTO') return;
    }
    try {
      await uploadPhoto(row);
    } catch (error) {
      // Rewind to CREATE so the user's Retry replays the POST and fetches a new signed link.
      if (error instanceof PhotoUploadUrlExpiredError && RESIGNS_ON_REPLAY.has(row.kind)) {
        await outbox.advanceStage(row.id, { stage: 'CREATE', photoUploadUrl: null });
      }
      throw error;
    }
    await outbox.advanceStage(row.id, { stage: 'DONE' });
  }
}

// The drain in progress (including any follow-up it loops into), for drainAndSettle().
let inFlight: Promise<void> | null = null;

export function drain(): Promise<void> {
  if (!tokens || !apiBaseUrl) return Promise.resolve();
  if (draining) {
    drainRequested = true;
    return Promise.resolve();
  }
  const run = runDrain();
  inFlight = run;
  void run.finally(() => {
    if (inFlight === run) inFlight = null;
  });
  return run;
}

/**
 * Drains and waits until no drain is running - including one another caller already started.
 * For a caller that must report the outcome (a headless notification action saying "Sent"),
 * where drain() alone could return at once because a drain was already in progress.
 */
/**
 * One bounded attempt to send the signed-in member's queued work (alert answers first among it)
 * while their session is still valid - at sign-out, where anything left waits for that member to
 * sign in again, which for a live call is too late. Never blocks longer than timeoutMs.
 */
export async function drainBriefly(timeoutMs: number): Promise<void> {
  if (!isConfigured()) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    drainAndSettle().catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

export async function drainAndSettle(): Promise<void> {
  await drain();
  while (inFlight) await inFlight;
}

async function runDrain(): Promise<void> {
  draining = true;
  drainRequested = false;
  try {
    // Runs inside the draining lock so no row of this process can be genuinely mid-sync.
    if (!recoveredOrphans) {
      await outbox.recoverOrphanedSyncing();
      recoveredOrphans = true;
    }
    const netState = await NetInfo.fetch();
    if (netState.isConnected !== true) return;

    // One session for the whole run (R5-M1). If the member signs out and another signs in while
    // this run is still going (the bounded sign-out drain gives up waiting, not the drain), the
    // run stops at the next row: nothing listed for the old member is posted with the new
    // member's tokens. The new session's own drain, queued behind this one, picks up its rows.
    const runTokens = tokens;
    const runApiBaseUrl = apiBaseUrl;
    const runOwner = owner.memberId;
    if (!runTokens || !runApiBaseUrl) return;
    const session: RunSession = { tokens: runTokens, apiBaseUrl: runApiBaseUrl };
    // Only the signed-in member's own rows (R2-M3).
    const pending = await outbox.listDrainable(Date.now(), runOwner);
    for (const listed of pending) {
      if (tokens !== runTokens || owner.memberId !== runOwner) break;
      // Re-read: a row listed above may have been discarded or superseded since (a changed
      // answer), and a vanished row must not be reported as delivered.
      const row = await outbox.find(listed.id);
      if (!row) continue;
      // An older answer that was mid-send when the member changed it, then failed: drop it.
      if (row.kind === 'RESPONSE' && (await outbox.isSuperseded(row))) {
        await outbox.discard(row.id);
        await notify();
        continue;
      }
      // Conditional: a mark-off that replaced this row may have deleted it since it was read.
      if (!(await outbox.claimForSync(row.id))) continue;
      await notify();
      try {
        await processEntry(row.id, session);
        await outbox.markSynced(row.id);
        rememberSynced(row.id);
        lastSyncAt = new Date().toISOString();
      } catch (error) {
        if (isPermanentRejection(error)) {
          await outbox.markRejected(row.id, describeError(error));
        } else {
          await outbox.markFailed(row.id, describeError(error));
        }
      }
      await notify();
    }
  } finally {
    draining = false;
  }
  // Awaited (not fire-and-forget) so drainAndSettle covers the follow-up pass too.
  if (drainRequested) await drain();
}
