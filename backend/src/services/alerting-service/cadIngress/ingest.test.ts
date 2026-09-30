import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  RAW_ADDRESS,
  RAW_INCIDENT_TYPE,
  buildCadDispatch,
  cadExternalDispatchId,
  ingestCadDispatch,
} from './ingest.js';
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

describe('cadExternalDispatchId', () => {
  it('is the same for a resend and differs for a new dispatch time', () => {
    const a = cadExternalDispatchId('county', { incidentNumber: '1', dispatchTime: 'T1' }, 'x');
    const b = cadExternalDispatchId('county', { incidentNumber: '1', dispatchTime: 'T1' }, 'y');
    const c = cadExternalDispatchId('county', { incidentNumber: '1', dispatchTime: 'T2' }, 'x');
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
    // Lock, alert, bridge outbox row: exactly createManualDispatch's three items.
    expect(items.map((item) => item.entityType ?? item.eventType)).toHaveLength(3);
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

  it('a CAD resend of the same incident + dispatch time does not page twice', async () => {
    const { client, items } = fakeDynamo();
    const input = {
      deptId: DEPT,
      source: SOURCE,
      channel: 'cad-email' as const,
      text: TEXT,
      receivedAt: 1_800_000_000,
    };
    expect((await ingestCadDispatch(client, 'alerting', input)).outcome).toBe('created');
    // Re-wrapped, re-sent a minute later: same incident number and dispatch time.
    const resend = { ...input, text: `${TEXT}\n\n-- resent`, receivedAt: 1_800_000_060 };
    expect(await ingestCadDispatch(client, 'alerting', resend)).toEqual({
      outcome: 'duplicate',
      parseStatus: 'PARSED',
    });
    expect(items.filter((item) => item.entityType === 'DISPATCH_ALERT')).toHaveLength(1);
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
