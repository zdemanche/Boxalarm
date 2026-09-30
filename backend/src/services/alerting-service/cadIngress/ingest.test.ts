import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  RAW_ADDRESS,
  RAW_INCIDENT_TYPE,
  buildCadDispatch,
  cadExternalDispatchId,
  TEXT_IDENTITY_SECONDS,
  ingestCadDispatch,
} from './ingest.js';
import { fakeDynamo as fakeDynamoTable, type FakeTable } from './__fixtures__/fakeTable.js';
import type { CadSourceCopy } from './sourceCopy.js';

const DEPT = toVerifiedDeptId({ deptId: 'nichols-fd' });

const SOURCE: CadSourceCopy = {
  sourceId: 'county',
  label: 'County CAD',
  enabled: true,
  parser: {
    version: 4,
    fields: {
      incidentNumber: { label: 'INC' },
      dispatchTime: { label: 'TIME' },
      incidentType: { label: 'TYPE' },
      address: { label: 'ADDR' },
      crossStreets: { label: 'XST' },
      units: { label: 'UNITS' },
    },
  },
};

const TEXT = [
  'INC: 2026-4471',
  'TIME: 09/30/2026 03:12',
  'TYPE: STRUCTURE FIRE',
  'ADDR: 123 MAIN ST, NICHOLS',
  'XST: ELM / OAK',
  'UNITS: E1, L2',
].join('\n');

/** Emulates the transaction's conditional lock put: a second write of the same lock fails. */
function fakeDynamo() {
  const locks = new Set<string>();
  const items: Record<string, unknown>[] = [];
  const send = vi.fn((command: TransactWriteCommand) => {
    const transactItems = command.input.TransactItems ?? [];
    const lockPk = String(transactItems[0]?.Put?.Item?.pk);
    if (locks.has(lockPk)) {
      return Promise.reject(
        new TransactionCanceledException({
          message: 'cancelled',
          $metadata: {},
          CancellationReasons: [{ Code: 'ConditionalCheckFailed' }, { Code: 'None' }],
        }),
      );
    }
    locks.add(lockPk);
    for (const entry of transactItems) items.push(entry.Put?.Item as Record<string, unknown>);
    return Promise.resolve({});
  });
  return { client: { send } as unknown as DynamoDBDocumentClient, items, send };
}

function alertOf(items: Record<string, unknown>[]) {
  return items.find((item) => item.entityType === 'DISPATCH_ALERT') as Record<string, unknown>;
}

describe('buildCadDispatch', () => {
  it('structures a parsed dispatch with locality from the address town', () => {
    const built = buildCadDispatch(SOURCE, TEXT, undefined);
    expect(built.parseStatus).toBe('PARSED');
    expect(built.parserVersion).toBe(4);
    expect(built.dispatch).toMatchObject({
      sourceSystem: 'CAD',
      incidentType: 'STRUCTURE FIRE',
      address: '123 MAIN ST, NICHOLS',
      crossStreets: 'ELM / OAK',
      unitsRequested: ['E1', 'L2'],
      locality: { town: 'NICHOLS', choice: 'OTHER' },
    });
    // No narrative field: the whole text is the narrative.
    expect(built.dispatch.narrative).toContain('INC: 2026-4471');
  });

  it('fails OPEN: unparseable text pages as RAW with SEE DISPATCH TEXT', () => {
    const built = buildCadDispatch(SOURCE, 'Fire at the old mill, units respond', undefined);
    expect(built.parseStatus).toBe('RAW');
    expect(built.dispatch).toMatchObject({
      incidentType: RAW_INCIDENT_TYPE,
      address: RAW_ADDRESS,
      narrative: 'Fire at the old mill, units respond',
    });
    expect(built.dispatch.locality).toBeUndefined();
  });

  it('a source with no template is RAW, not an error', () => {
    const noTemplate: CadSourceCopy = { sourceId: 'county', label: 'County CAD', enabled: true };
    expect(buildCadDispatch(noTemplate, TEXT, undefined).parseStatus).toBe('RAW');
  });

  it('structured webhook fields with an address win over the template', () => {
    const built = buildCadDispatch(SOURCE, '{}', {
      address: '9 OAK AVE',
      incidentType: 'ALARM',
      town: 'Trumbull',
    });
    expect(built.parseStatus).toBe('PARSED');
    expect(built.parserVersion).toBeNull();
    expect(built.dispatch).toMatchObject({
      address: '9 OAK AVE',
      incidentType: 'ALARM',
      locality: { town: 'Trumbull', choice: 'OTHER' },
    });
  });
});

describe('structured fields win over the template (chain review m2)', () => {
  it('a structured field the CAD sent is kept even when the template reads a different value', () => {
    const built = buildCadDispatch(SOURCE, 'TYPE: FROM TEXT\nADDR: 9 ELM ST', {
      incidentType: 'FROM STRUCTURED',
    });
    expect(built.dispatch.incidentType).toBe('FROM STRUCTURED');
    expect(built.dispatch.address).toBe('9 ELM ST');
  });
});

describe('cadExternalDispatchId', () => {
  it('is the incident number alone: a new dispatch time is the same incident (an update)', () => {
    const a = cadExternalDispatchId('county', { incidentNumber: '1', dispatchTime: 'T1' }, 'x');
    const b = cadExternalDispatchId('county', { incidentNumber: '1', dispatchTime: 'T2' }, 'y');
    const c = cadExternalDispatchId('county', { incidentNumber: '2', dispatchTime: 'T1' }, 'x');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^county\.[0-9a-f]{40}$/);
  });

  it('falls back to the text fingerprint without an incident number', () => {
    expect(cadExternalDispatchId('county', {}, 'SAME TEXT')).toBe(
      cadExternalDispatchId('county', {}, 'same\r\ntext'),
    );
  });
});

describe('ingestCadDispatch', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('writes the SAME DISPATCH_ALERT transaction as the manual path, tagged with the source', async () => {
    const { client, items } = fakeDynamo();
    const result = await ingestCadDispatch(client, 'alerting', {
      deptId: DEPT,
      source: SOURCE,
      channel: 'cad-webhook',
      text: TEXT,
      receivedAt: 1_800_000_000,
    });
    expect(result).toMatchObject({ outcome: 'created', parseStatus: 'PARSED' });
    // Lock, alert, bridge outbox row (createManualDispatch's three items) + the CAD content's
    // SEEN# marker (chain review R2-M1).
    expect(items.map((item) => item.entityType)).toEqual([
      'DISPATCH_IDEMPOTENCY_LOCK',
      'DISPATCH_ALERT',
      'OUTBOX_ENTRY',
      'CAD_SEEN_CONTENT',
    ]);
    expect(String(items[0]?.pk)).toMatch(/^DEPT#nichols-fd#DISPATCH_IDEMPOTENCY#CAD#county\./);
    expect(alertOf(items)).toMatchObject({
      sourceSystem: 'CAD',
      deptId: 'nichols-fd',
      ingressChannel: 'cad-webhook',
      cadSourceId: 'county',
      cadParseStatus: 'PARSED',
      cadParserVersion: 4,
      verifyRequired: false,
      cadIncidentNumber: '2026-4471',
      toneLadderStatus: 'ACTIVE',
      isTest: false,
    });
    expect(String(alertOf(items).dispatchId)).toMatch(/^nichols-fd-CAD-1800000000-/);
  });

  it('an identical CAD resend of the same incident does not page twice', async () => {
    const table: FakeTable = { items: new Map() };
    const input = {
      deptId: DEPT,
      source: SOURCE,
      channel: 'cad-email' as const,
      text: TEXT,
      receivedAt: 1_800_000_000,
    };
    expect((await ingestCadDispatch(fakeDynamoTable(table), 'alerting', input)).outcome).toBe(
      'created',
    );
    // Re-wrapped, re-sent a minute later: same content.
    const resend = {
      ...input,
      text: `${TEXT.replace(/\n/g, '\r\n')}\n`,
      receivedAt: 1_800_000_060,
    };
    expect(await ingestCadDispatch(fakeDynamoTable(table), 'alerting', resend)).toEqual({
      outcome: 'duplicate',
      parseStatus: 'PARSED',
    });
    expect([...table.items.values()].filter((i) => i.entityType === 'DISPATCH_ALERT')).toHaveLength(
      1,
    );
    expect(
      vi
        .mocked(console.log)
        .mock.calls.some(([line]) => String(line).includes('"Name":"CadIngressDuplicate"')),
    ).toBe(true);
  });

  it('flags a RAW dispatch VERIFY and records the parse outcome metric', async () => {
    const { client, items } = fakeDynamo();
    await ingestCadDispatch(client, 'alerting', {
      deptId: DEPT,
      source: SOURCE,
      channel: 'cad-email',
      text: 'garbled',
      receivedAt: 1_800_000_000,
    });
    expect(alertOf(items)).toMatchObject({
      address: RAW_ADDRESS,
      cadParseStatus: 'RAW',
      verifyRequired: true,
      narrative: 'garbled',
    });
    const logged = vi.mocked(console.log).mock.calls.map(([line]) => String(line));
    expect(logged.some((l) => l.includes('"CadIngressParsed":1') && l.includes('"RAW"'))).toBe(
      true,
    );
    expect(logged.some((l) => l.includes('"CadIngressRawFallback":1'))).toBe(true);
  });
});

describe('text-only identities expire (chain review C1)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  // No incidentNumber rule: identity is the text fingerprint alone.
  const NO_INCIDENT: CadSourceCopy = {
    sourceId: 'county',
    label: 'County CAD',
    enabled: true,
    parser: { version: 1, fields: { incidentType: { label: 'TYPE' }, address: { label: 'ADDR' } } },
  };
  const REPEAT = 'TYPE: MEDICAL\nADDR: 100 ELM ST';

  async function send(table: FakeTable, receivedAt: number, source = NO_INCIDENT) {
    return ingestCadDispatch(fakeDynamoTable(table), 'alerting', {
      deptId: DEPT,
      source,
      channel: 'cad-webhook',
      text: REPEAT,
      receivedAt,
    });
  }

  const alertCount = (table: FakeTable) =>
    [...table.items.values()].filter((i) => i.entityType === 'DISPATCH_ALERT').length;

  it('two identical-text calls an hour apart BOTH page', async () => {
    const table: FakeTable = { items: new Map() };
    expect((await send(table, 1_800_000_000)).outcome).toBe('created');
    expect((await send(table, 1_800_003_600)).outcome).toBe('created');
    expect(alertCount(table)).toBe(2);
  });

  it('a resend of identical text inside 10 minutes does not page again', async () => {
    const table: FakeTable = { items: new Map() };
    expect((await send(table, 1_800_000_000)).outcome).toBe('created');
    expect((await send(table, 1_800_000_000 + TEXT_IDENTITY_SECONDS - 1)).outcome).toBe(
      'duplicate',
    );
    expect(alertCount(table)).toBe(1);
    const logged = vi.mocked(console.log).mock.calls.map(([l]) => String(l));
    expect(logged.some((l) => l.includes('"CadIngressDuplicate":1') && l.includes('"text"'))).toBe(
      true,
    );
  });

  it('a source with no template never swallows a repeat call past the window', async () => {
    const table: FakeTable = { items: new Map() };
    const bare: CadSourceCopy = { sourceId: 'county', label: 'County CAD', enabled: true };
    expect((await send(table, 1_800_000_000, bare)).outcome).toBe('created');
    expect((await send(table, 1_800_000_000 + TEXT_IDENTITY_SECONDS, bare)).outcome).toBe(
      'created',
    );
  });

  it('the lock records its expiry and a TTL for cleanup', async () => {
    const table: FakeTable = { items: new Map() };
    await send(table, 1_800_000_000);
    const lock = [...table.items.values()].find(
      (i) => i.entityType === 'DISPATCH_IDEMPOTENCY_LOCK',
    );
    expect(lock).toMatchObject({
      expiresAt: 1_800_000_000 + TEXT_IDENTITY_SECONDS,
      ttl: 1_800_000_000 + TEXT_IDENTITY_SECONDS + 7 * 24 * 60 * 60,
    });
  });
});

describe('CAD updates to an incident already paged (decision 2026-09-30)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  const at = (table: FakeTable, text: string, receivedAt: number) =>
    ingestCadDispatch(fakeDynamoTable(table), 'alerting', {
      deptId: DEPT,
      source: SOURCE,
      channel: 'cad-webhook',
      text,
      receivedAt,
    });
  const items = (table: FakeTable, type: string) =>
    [...table.items.values()].filter((i) => i.entityType === type);

  it('a later message for the same incident is an UPDATE: history recorded, dispatch refreshed, no new page', async () => {
    const table: FakeTable = { items: new Map() };
    const created = await at(table, TEXT, 1_800_000_000);
    expect(created.outcome).toBe('created');
    const outboxBefore = [...table.items.values()].filter((i) => i.eventType).length;

    const update = TEXT.replace('TIME: 09/30/2026 03:12', 'TIME: 09/30/2026 03:15').replace(
      'UNITS: E1, L2',
      'UNITS: E1, L2, R1',
    );
    const result = await at(table, update, 1_800_000_180);
    expect(result).toMatchObject({ outcome: 'updated', parseStatus: 'PARSED' });
    expect(items(table, 'DISPATCH_ALERT')).toHaveLength(1);
    expect(items(table, 'DISPATCH_ALERT')[0]).toMatchObject({
      unitsRequested: ['E1', 'L2', 'R1'],
      updateCount: 1,
      lastUpdatedAt: 1_800_000_180,
    });
    const history = items(table, 'DISPATCH_UPDATE');
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      summary: 'Units: E1, L2, R1',
      changes: expect.arrayContaining([
        { field: 'unitsRequested', from: 'E1, L2', to: 'E1, L2, R1' },
      ]) as unknown,
    });
    // No second bridge event / incident draft.
    expect([...table.items.values()].filter((i) => i.eventType).length).toBe(outboxBefore);
  });

  it('notifier gap: an update leaves a pending marker; a retry of an unnotified update hands it off again', async () => {
    const table: FakeTable = { items: new Map() };
    await at(table, TEXT, 1_800_000_000);
    const update = TEXT.replace('XST: ELM / OAK', 'XST: ELM / PINE');
    expect((await at(table, update, 1_800_000_100)).outcome).toBe('updated');
    expect(items(table, 'CAD_UPDATE_PENDING')).toHaveLength(1);
    // The ingress Lambda died after commit: no notifiedAt. The CAD retries the same update.
    expect((await at(table, update, 1_800_000_160)).outcome).toBe('duplicate');
    const logged = () => vi.mocked(console.log).mock.calls.map(([l]) => String(l));
    expect(logged().filter((l) => l.includes('"CadUpdateNoticeRedriven":1'))).toHaveLength(1);
    // Once notified, a retry hands nothing off.
    const record = items(table, 'DISPATCH_UPDATE')[0]!;
    record.notifiedAt = 1_800_000_200;
    await at(table, update, 1_800_000_220);
    expect(logged().filter((l) => l.includes('"CadUpdateNoticeRedriven":1'))).toHaveLength(1);
  });

  it('R2-M1: the original re-sent after a correction is a duplicate - no revert, no push', async () => {
    const table: FakeTable = { items: new Map() };
    const original = 'INC: 2026-7\nADDR: 12 ELM ST, NICHOLS\nUNITS: E1';
    const correction = 'INC: 2026-7\nADDR: 21 ELM ST, NICHOLS\nUNITS: E1, L1';
    expect((await at(table, original, 1_800_000_000)).outcome).toBe('created');
    expect((await at(table, correction, 1_800_000_060)).outcome).toBe('updated');
    // The delayed email / re-signed retry of the ORIGINAL arrives now.
    expect((await at(table, original, 1_800_000_120)).outcome).toBe('duplicate');
    expect(items(table, 'DISPATCH_ALERT')[0]).toMatchObject({
      address: '21 ELM ST, NICHOLS',
      unitsRequested: ['E1', 'L1'],
    });
    // Exactly one update was handed to the notifier (the correction); the re-sent original none.
    const updatedCount = vi
      .mocked(console.log)
      .mock.calls.filter(([l]) => String(l).includes('"CadIngressUpdated":1')).length;
    expect(updatedCount).toBe(1);
    expect(items(table, 'DISPATCH_UPDATE')).toHaveLength(1);
  });

  it('R2-M1: a message the CAD stamped earlier than the applied one is history only, never applied', async () => {
    const table: FakeTable = { items: new Map() };
    await at(
      table,
      TEXT.replace('TIME: 09/30/2026 03:12', 'TIME: 09/30/2026 03:20'),
      1_800_000_000,
    );
    const older = TEXT.replace('TIME: 09/30/2026 03:12', 'TIME: 09/30/2026 03:15').replace(
      'ADDR: 123 MAIN ST, NICHOLS',
      'ADDR: 999 WRONG RD',
    );
    expect((await at(table, older, 1_800_000_100)).outcome).toBe('duplicate');
    expect(items(table, 'DISPATCH_ALERT')[0]?.address).toBe('123 MAIN ST, NICHOLS');
    expect(items(table, 'DISPATCH_UPDATE')[0]).toMatchObject({ applied: false, changes: [] });
    const logged = vi.mocked(console.log).mock.calls.map(([l]) => String(l));
    expect(logged.some((l) => l.includes('"CadIngressOlderMessage":1'))).toBe(true);
  });

  it('a RAW update refreshes the VERIFY excerpt every later page carries', async () => {
    const { pageLocationText, readDispatchAlertText } =
      await import('../channels/channelEnvelope.js');
    const table: FakeTable = { items: new Map() };
    const bare: CadSourceCopy = {
      sourceId: 'county',
      label: 'County',
      enabled: true,
      parser: {
        version: 1,
        fields: { incidentNumber: { label: 'INC' }, address: { label: 'ADDR' } },
      },
    };
    const send = (text: string, t: number) =>
      ingestCadDispatch(fakeDynamoTable(table), 'alerting', {
        deptId: DEPT,
        source: bare,
        channel: 'cad-email',
        text,
        receivedAt: t,
      });
    await send('INC: 8\nSMOKE NEAR THE MILL', 1_800_000_000);
    expect((await send('INC: 8\nNOW FLAMES AT THE DAM', 1_800_000_060)).outcome).toBe('updated');
    const alert = items(table, 'DISPATCH_ALERT')[0]!;
    expect(pageLocationText(readDispatchAlertText(alert))).toBe(
      'VERIFY: INC: 8 NOW FLAMES AT THE DAM',
    );
  });

  it('an identical resend of an update records it once', async () => {
    const table: FakeTable = { items: new Map() };
    await at(table, TEXT, 1_800_000_000);
    const update = TEXT.replace('XST: ELM / OAK', 'XST: ELM / PINE');
    expect((await at(table, update, 1_800_000_100)).outcome).toBe('updated');
    expect((await at(table, update, 1_800_000_160)).outcome).toBe('duplicate');
    expect(items(table, 'DISPATCH_UPDATE')).toHaveLength(1);
  });

  it('a RAW update never replaces a structured address with the placeholder', async () => {
    const table: FakeTable = { items: new Map() };
    await at(table, TEXT, 1_800_000_000);
    // Same incident number read, but no address line this time.
    expect(
      (await at(table, 'INC: 2026-4471\nCALLER NOW REPORTS FLAMES', 1_800_000_100)).outcome,
    ).toBe('updated');
    expect(items(table, 'DISPATCH_ALERT')[0]).toMatchObject({
      address: '123 MAIN ST, NICHOLS',
      narrative: 'INC: 2026-4471\nCALLER NOW REPORTS FLAMES',
    });
  });
});

describe('template deadline (security review M3)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('a catastrophic template pages RAW (not a stalled Lambda) and is counted', async () => {
    const table: FakeTable = { items: new Map() };
    const result = await ingestCadDispatch(fakeDynamoTable(table), 'alerting', {
      deptId: DEPT,
      source: {
        sourceId: 'county',
        label: 'County',
        enabled: true,
        parser: { version: 3, fields: { address: { pattern: '(a|a)*$' } } },
      },
      channel: 'cad-webhook',
      text: `${'a'.repeat(40)}!`,
      receivedAt: 1_800_000_000,
    });
    expect(result).toMatchObject({ outcome: 'created', parseStatus: 'RAW' });
    const logged = vi.mocked(console.log).mock.calls.map(([l]) => String(l));
    expect(logged.some((l) => l.includes('"CadParseTimeout":1'))).toBe(true);
  }, 10_000);
});
