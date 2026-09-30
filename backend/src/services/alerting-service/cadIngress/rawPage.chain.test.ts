import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  RAW_PAGE_EXCERPT_MAX_BYTES,
  buildChannelPagePayload,
  parseChannelEnvelope,
  readDispatchAlertText,
} from '../channels/channelEnvelope.js';
import { buildApnsPayload, pushDataFields } from '../channels/push/pushPayload.js';
import { fakeDynamo, type FakeTable } from './__fixtures__/fakeTable.js';
import { ingestCadDispatch } from './ingest.js';

/**
 * Chain review M1: a RAW (fail-open) CAD dispatch, from ingest through the DISPATCH_ALERT the
 * stream fan-out reads, the envelope it publishes and the channel worker's own parse, to the
 * text each channel sends. Every channel must carry what the CAD said, not "SEE DISPATCH TEXT".
 */

const DEPT = toVerifiedDeptId({ deptId: 'nichols-fd' });
const RAW_TEXT = 'SMOKE REPORTED BEHIND THE OLD MILL ON RIVER RD NEAR THE DAM, CALLER ON SCENE';

describe('RAW CAD page carries the dispatch text on push, SMS and voice', () => {
  beforeEach(() => vi.spyOn(console, 'log').mockImplementation(() => undefined));
  afterEach(() => vi.restoreAllMocks());

  async function rawAlert(text = RAW_TEXT) {
    const table: FakeTable = { items: new Map() };
    await ingestCadDispatch(fakeDynamo(table), 'alerting', {
      deptId: DEPT,
      source: { sourceId: 'county', label: 'County', enabled: true },
      channel: 'cad-email',
      text,
      receivedAt: 1_800_000_000,
    });
    return [...table.items.values()].find((i) => i.entityType === 'DISPATCH_ALERT')!;
  }

  function envelopeFor(alert: Record<string, unknown>, channel: 'push' | 'sms' | 'voice') {
    const body = JSON.stringify({
      payload: buildChannelPagePayload({
        deptId: DEPT,
        dispatchId: String(alert.dispatchId),
        memberId: 'mbr-1',
        channel,
        channelTier: channel === 'voice' ? 'escalation' : 'primary',
        toneSequence: 1,
        dispatch: readDispatchAlertText(alert),
      }),
    });
    return parseChannelEnvelope(body, channel);
  }

  it.each(['push', 'sms', 'voice'] as const)(
    '%s: the worker message contains the dispatch text',
    async (channel) => {
      const alert = await rawAlert();
      expect(alert).toMatchObject({ address: 'SEE DISPATCH TEXT', verifyRequired: true });
      const envelope = envelopeFor(alert, channel);
      // deliverChannelMessage.ts builds every channel's text as "{type} — {address}".
      const message = `${envelope.incidentType} — ${envelope.address}`;
      expect(message).toContain('VERIFY: SMOKE REPORTED BEHIND THE OLD MILL ON RIVER RD');
      expect(message).not.toContain('SEE DISPATCH TEXT');
    },
  );

  it('caps the excerpt in bytes (APNs 4 KB, two SMS segments) and the push payload stays small', async () => {
    const alert = await rawAlert(`${'ÉCHO '.repeat(2000)}END`);
    const envelope = envelopeFor(alert, 'push');
    expect(Buffer.byteLength(envelope.address)).toBeLessThanOrEqual(
      RAW_PAGE_EXCERPT_MAX_BYTES + 'VERIFY: '.length,
    );
    const notification = {
      token: 't',
      alertKind: 'dispatch' as const,
      dispatchId: String(alert.dispatchId),
      toneSequence: 1,
      title: envelope.incidentType,
      body: `${envelope.incidentType} — ${envelope.address}`,
      idempotencyKey: 'k',
      collapseKey: 'c',
      alert: { incidentType: envelope.incidentType, address: envelope.address },
    };
    expect(
      Buffer.byteLength(JSON.stringify(buildApnsPayload(notification, 'critical'))),
    ).toBeLessThan(4096);
    expect(pushDataFields(notification).address).toContain('VERIFY:');
  });

  it('a structured (PARSED) dispatch still pages with its address', async () => {
    const table: FakeTable = { items: new Map() };
    await ingestCadDispatch(fakeDynamo(table), 'alerting', {
      deptId: DEPT,
      source: {
        sourceId: 'county',
        label: 'County',
        enabled: true,
        parser: { version: 1, fields: { address: { label: 'ADDR' } } },
      },
      channel: 'cad-email',
      text: 'ADDR: 9 OAK AVE',
      receivedAt: 1_800_000_000,
    });
    const alert = [...table.items.values()].find((i) => i.entityType === 'DISPATCH_ALERT')!;
    expect(envelopeFor(alert, 'sms').address).toBe('9 OAK AVE');
  });
});
