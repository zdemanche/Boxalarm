import { generateKeyPairSync, verify, type KeyObject } from 'node:crypto';
import {
  createServer,
  type Http2Server,
  type IncomingHttpHeaders,
  type ServerHttp2Session,
} from 'node:http2';
import type { AddressInfo } from 'node:net';
import type { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  APNS_SESSION_MAX_IDLE_MS,
  http2Transport,
  isConnectionLevelError,
  resetApnsSessions,
} from './http2.js';
import { resetPushCredentialCaches } from './pushCredentials.js';
import { sendApns, type ApnsMessage } from './apnsSend.js';

/**
 * The package's own behavior tests (review m1): adapted from the alerting adapter suites so
 * the transport core stays covered where it lives — both planes import it, and a regression
 * must fail here even if the alerting suites stop exercising a path.
 */

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const P8 = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const TOKEN = 'a'.repeat(64);

function apnsSecret(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    teamId: 'TEAM123456',
    keyId: 'KEY1234567',
    privateKey: P8,
    bundleId: 'org.nicholsfd.boxalarm',
    ...overrides,
  });
}

function secretsClient(secretString: string): {
  client: SecretsManagerClient;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn().mockResolvedValue({ SecretString: secretString });
  return { client: { send } as unknown as SecretsManagerClient, send };
}

function decodeJwt(jwt: string, key: KeyObject) {
  const [header, claims, signature] = jwt.split('.') as [string, string, string];
  const valid = verify(
    'sha256',
    Buffer.from(`${header}.${claims}`),
    { key, dsaEncoding: 'ieee-p1363' },
    Buffer.from(signature, 'base64url'),
  );
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString()) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(claims, 'base64url').toString()) as Record<string, unknown>,
    valid,
  };
}

const MESSAGE: ApnsMessage = {
  token: TOKEN,
  headers: {
    'apns-push-type': 'alert',
    'apns-priority': '10',
    'apns-id': '00000000-0000-8000-8000-000000000001',
    'apns-collapse-id': 'collapse-1',
  },
  buildPayload: (credentials) => ({
    aps: { alert: { title: 'T', body: 'B' } },
    level: credentials.interruptionLevel,
  }),
};

interface Captured {
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

describe('sendApns over a local HTTP/2 server', () => {
  let server: Http2Server;
  let origin: string;
  const captured: Captured[] = [];
  let reply: { status: number; body?: string } = { status: 200 };
  const replyQueue: { status: number; body?: string }[] = [];

  beforeAll(async () => {
    server = createServer();
    server.on('stream', (stream, headers) => {
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        captured.push({ headers, body: Buffer.concat(chunks).toString('utf8') });
        const next = replyQueue.shift() ?? reply;
        stream.respond({ ':status': next.status, 'apns-id': String(headers['apns-id']) });
        stream.end(next.body ?? '');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    resetApnsSessions();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => {
    captured.length = 0;
    reply = { status: 200 };
    replyQueue.length = 0;
    resetPushCredentialCaches();
  });

  const send = (secret = apnsSecret(), message = MESSAGE, extra = {}) =>
    sendApns(message, {
      secretId: 'apns-prod',
      isTest: false,
      secretsClient: secretsClient(secret).client,
      timeoutMs: 4_000,
      origin,
      ...extra,
    });

  it('assembles :path, the bearer provider token, apns-topic and the caller headers', async () => {
    const result = await send();

    expect(result).toEqual({
      outcome: 'sent',
      providerMessageId: '00000000-0000-8000-8000-000000000001',
    });
    const request = captured[0]!;
    expect(request.headers[':path']).toBe(`/3/device/${TOKEN}`);
    expect(request.headers['apns-topic']).toBe('org.nicholsfd.boxalarm');
    expect(request.headers['apns-push-type']).toBe('alert');
    expect(request.headers['apns-priority']).toBe('10');
    expect(request.headers['apns-collapse-id']).toBe('collapse-1');
    const jwt = String(request.headers.authorization).replace(/^bearer /, '');
    const decoded = decodeJwt(jwt, publicKey);
    expect(decoded.valid).toBe(true);
    expect(decoded.header).toMatchObject({ alg: 'ES256', kid: 'KEY1234567' });
    expect(decoded.claims).toMatchObject({ iss: 'TEAM123456' });
  });

  it('builds the payload per attempt from the read credentials', async () => {
    await send(apnsSecret({ interruptionLevel: 'time-sensitive' }));
    expect(JSON.parse(captured[0]!.body)).toMatchObject({ level: 'time-sensitive' });
  });

  it('maps 410 to invalid_token and carries the timestamp', async () => {
    reply = { status: 410, body: JSON.stringify({ reason: 'Unregistered', timestamp: 123 }) };
    await expect(send()).resolves.toEqual({
      outcome: 'invalid_token',
      reason: 'APNS_Unregistered',
      invalidSinceMs: 123,
    });
  });

  it('maps BadDeviceToken to invalid_token without a timestamp', async () => {
    reply = { status: 400, body: JSON.stringify({ reason: 'BadDeviceToken' }) };
    await expect(send()).resolves.toEqual({
      outcome: 'invalid_token',
      reason: 'APNS_BadDeviceToken',
    });
  });

  it('retries a refused provider token once with freshly read credentials, then throws', async () => {
    replyQueue.push(
      { status: 403, body: JSON.stringify({ reason: 'ExpiredProviderToken' }) },
      { status: 403, body: JSON.stringify({ reason: 'ExpiredProviderToken' }) },
    );
    const secrets = secretsClient(apnsSecret());

    await expect(
      sendApns(MESSAGE, {
        secretId: 'apns-prod',
        isTest: false,
        secretsClient: secrets.client,
        timeoutMs: 4_000,
        origin,
      }),
    ).rejects.toThrow('ExpiredProviderToken');
    // Evict-and-retry-once: the secret was re-read for the second attempt.
    expect(secrets.send).toHaveBeenCalledTimes(2);
    expect(captured).toHaveLength(2);
  });

  it('a test refused for configuration is terminal, never thrown into a DLQ', async () => {
    reply = { status: 400, body: JSON.stringify({ reason: 'TopicDisallowed' }) };
    await expect(send(apnsSecret(), MESSAGE, { isTest: true })).resolves.toEqual({
      outcome: 'test_refused',
      reason: 'APNS_TopicDisallowed',
    });
  });

  it('a real send refused for configuration still throws (dead-letter and page on-call)', async () => {
    reply = { status: 400, body: JSON.stringify({ reason: 'TopicDisallowed' }) };
    await expect(send()).rejects.toThrow('APNs responded 400 TopicDisallowed');
  });

  it('refuses a sandbox secret that declares environment=production (fail closed)', async () => {
    await expect(
      send(apnsSecret({ environment: 'production' }), MESSAGE, { sandboxSecret: true }),
    ).rejects.toThrow('declares environment "production"');
    expect(captured).toHaveLength(0);
  });
});

describe('http2Transport session handling (package home of review M1)', () => {
  let server: Http2Server;
  let origin: string;
  const serverSessions: ServerHttp2Session[] = [];

  beforeAll(async () => {
    server = createServer();
    server.on('session', (session) => serverSessions.push(session));
    server.on('stream', (stream) => {
      stream.on('error', () => undefined);
      const respond = () => {
        stream.respond({ ':status': 200 });
        stream.end('');
      };
      stream.on('end', respond).resume();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    resetApnsSessions();
    for (const session of serverSessions) session.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => {
    resetApnsSessions();
    for (const session of serverSessions) session.destroy();
    serverSessions.length = 0;
    vi.useRealTimers();
  });

  const post = (path: string, timeoutMs = 2_000) =>
    http2Transport(origin, { ':path': `/3/device/${path}` }, '{}', timeoutMs);

  it('reuses one connection across sends', async () => {
    await expect(post('first')).resolves.toMatchObject({ status: 200 });
    await expect(post('second')).resolves.toMatchObject({ status: 200 });
    expect(serverSessions).toHaveLength(1);
  });

  it('a connection the server closed while idle is replaced in-process', async () => {
    await post('first');
    serverSessions[0]!.destroy();
    await expect(post('second')).resolves.toMatchObject({ status: 200 });
    expect(serverSessions).toHaveLength(2);
  });

  it('a session idle past the threshold is replaced before use, not trusted', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    await post('first');
    await post('soon-after');
    expect(serverSessions).toHaveLength(1);
    vi.setSystemTime(Date.now() + APNS_SESSION_MAX_IDLE_MS + 1_000);
    await post('after-idle');
    expect(serverSessions).toHaveLength(2);
  });

  it('classifies connection-level errors (and only those) as retryable', () => {
    for (const code of ['ECONNRESET', 'EPIPE', 'ERR_HTTP2_GOAWAY_SESSION']) {
      expect(isConnectionLevelError(Object.assign(new Error(code), { code }))).toBe(true);
    }
    expect(isConnectionLevelError(new Error('APNs responded 500'))).toBe(false);
  });
});
