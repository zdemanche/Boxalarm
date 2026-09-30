import { describe, expect, it, vi } from 'vitest';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { evaluateSelfTestRun } from './evaluateSelfTestRun.js';

const KEY = { deptId: toVerifiedDeptId({ deptId: 'NICHOLS' }), memberId: 'mbr-1', testId: 't-1' };
const START_MS = 1_798_000_000_000;
const DISPATCH_PK = 'DEPT#NICHOLS#DISPATCH#NICHOLS-SELFTEST-1';

function running(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    overallResult: 'RUNNING',
    runAtMs: START_MS,
    channelsTested: ['PUSH', 'SMS'],
    channelResults: {},
    dispatchId: 'NICHOLS-SELFTEST-1',
    publishedChannels: ['PUSH', 'SMS'],
    ...overrides,
  };
}

/** Worker send guards keyed by channel, plus a spy on the completion write. */
function table(guards: Record<string, Record<string, unknown>>) {
  const send = vi.fn(
    (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (command.constructor.name === 'GetCommand') {
        const { pk, sk } = command.input.Key as { pk: string; sk: string };
        expect(pk).toBe(DISPATCH_PK);
        const channel = sk.split('#')[2]!;
        return Promise.resolve({ Item: guards[channel] });
      }
      return Promise.resolve({});
    },
  );
  const completion = () =>
    send.mock.calls
      .map(([command]) => command)
      .find((command) => command.constructor.name === 'UpdateCommand')?.input;
  return { client: { send } as unknown as DynamoDBDocumentClient, completion };
}

describe('evaluateSelfTestRun — PASS comes from worker receipts (design review C3)', () => {
  it('PASS when every published channel reached SENT within the budget', async () => {
    const t = table({
      PUSH: { sendState: 'SENT', completedAtMs: START_MS + 900 },
      SMS: { sendState: 'SENT', completedAtMs: START_MS + 1_400 },
    });
    const result = await evaluateSelfTestRun(t.client, 'tbl', KEY, running(), START_MS + 5_000, {
      latencyBudgetMs: 5_000,
    });
    expect(result).toMatchObject({
      overallResult: 'PASS',
      latencyMs: 1_400,
      channelResults: { PUSH: { ok: true, ms: 900 }, SMS: { ok: true, ms: 1_400 } },
    });
    expect(t.completion()).toMatchObject({
      ConditionExpression: 'overallResult = :running',
      ExpressionAttributeValues: { ':result': 'PASS' },
    });
  });

  it('stays RUNNING while a channel has no final receipt inside the timeout', async () => {
    const t = table({ PUSH: { sendState: 'SENT', completedAtMs: START_MS + 900 } });
    const result = await evaluateSelfTestRun(t.client, 'tbl', KEY, running(), START_MS + 3_000, {
      latencyBudgetMs: 5_000,
    });
    expect(result.overallResult).toBe('RUNNING');
    expect(t.completion()).toBeUndefined();
  });

  it('FAIL when a published page never got a worker receipt (worker down, missing bundle)', async () => {
    const t = table({
      PUSH: { sendState: 'SENT', completedAtMs: START_MS + 900 },
      SMS: { sendState: 'CLAIMED', sentAt: START_MS / 1000 },
    });
    const result = await evaluateSelfTestRun(t.client, 'tbl', KEY, running(), START_MS + 31_000, {
      latencyBudgetMs: 5_000,
    });
    expect(result.overallResult).toBe('FAIL');
    expect(result.channelResults.SMS).toMatchObject({
      ok: false,
      reason: expect.stringContaining('no worker receipt') as unknown,
    });
  });

  it('FAIL when the provider refused (missing credentials, outage, .invalid endpoint)', async () => {
    const t = table({
      PUSH: {
        sendState: 'FAILED',
        failureReason: 'APNs secret has no value',
        completedAtMs: START_MS + 300,
      },
      SMS: { sendState: 'SENT', completedAtMs: START_MS + 500 },
    });
    const result = await evaluateSelfTestRun(t.client, 'tbl', KEY, running(), START_MS + 1_000, {
      latencyBudgetMs: 5_000,
    });
    expect(result.overallResult).toBe('FAIL');
    expect(result.channelResults.PUSH?.reason).toBe('provider refused: APNs secret has no value');
  });

  it('FAIL when a channel was SENT outside the latency budget', async () => {
    const t = table({
      PUSH: { sendState: 'SENT', completedAtMs: START_MS + 7_000 },
      SMS: { sendState: 'SENT', completedAtMs: START_MS + 500 },
    });
    const result = await evaluateSelfTestRun(t.client, 'tbl', KEY, running(), START_MS + 8_000, {
      latencyBudgetMs: 5_000,
    });
    expect(result.overallResult).toBe('FAIL');
    expect(result.channelResults.PUSH).toMatchObject({ ok: false, ms: 7_000 });
  });

  it('keeps a channel the fan-out could not publish as the FAIL it already is', async () => {
    const t = table({ SMS: { sendState: 'SENT', completedAtMs: START_MS + 500 } });
    const result = await evaluateSelfTestRun(
      t.client,
      'tbl',
      KEY,
      running({
        publishedChannels: ['SMS'],
        channelResults: { PUSH: { ok: false, ms: 0, reason: 'push: no token registered' } },
      }),
      START_MS + 1_000,
      { latencyBudgetMs: 5_000 },
    );
    expect(result.overallResult).toBe('FAIL');
    expect(result.channelResults.PUSH?.reason).toBe('push: no token registered');
  });

  it('FAIL when every channel was SENT but the member is not eligible for a real page', async () => {
    const t = table({
      PUSH: { sendState: 'SENT', completedAtMs: START_MS + 500 },
      SMS: { sendState: 'SENT', completedAtMs: START_MS + 500 },
    });
    const result = await evaluateSelfTestRun(
      t.client,
      'tbl',
      KEY,
      running({ eligibilityReason: 'member is MARKED_OFF — a real dispatch would not page you' }),
      START_MS + 1_000,
      { latencyBudgetMs: 5_000 },
    );
    expect(result.overallResult).toBe('FAIL');
  });

  it('FAIL when the fan-out never processed the test dispatch', async () => {
    const t = table({});
    const result = await evaluateSelfTestRun(
      t.client,
      'tbl',
      KEY,
      { overallResult: 'RUNNING', runAtMs: START_MS, channelsTested: ['PUSH'], channelResults: {} },
      START_MS + 60_000,
      { latencyBudgetMs: 5_000 },
    );
    expect(result).toMatchObject({
      overallResult: 'FAIL',
      channelResults: { PUSH: { ok: false, reason: 'fan-out never processed the test dispatch' } },
    });
  });

  it('returns a finished run as it stands, with its latency, and reads nothing', async () => {
    const t = table({});
    const result = await evaluateSelfTestRun(
      t.client,
      'tbl',
      KEY,
      {
        overallResult: 'PASS',
        runAtMs: START_MS,
        completedAtMs: START_MS + 1_200,
        channelResults: {},
      },
      START_MS + 120_000,
      { latencyBudgetMs: 5_000 },
    );
    expect(result).toMatchObject({ overallResult: 'PASS', latencyMs: 1_200 });
    expect(t.completion()).toBeUndefined();
  });

  // Review round 2 item b: the canary's Android push only validates (FCM validate_only).
  it('reports a validate-only Android send as credentials verified, not delivered', async () => {
    const t = table({
      PUSH: {
        sendState: 'SENT',
        completedAtMs: START_MS + 400,
        deviceSends: { 'android-1': 'VALIDATED' },
      },
      SMS: { sendState: 'SENT', completedAtMs: START_MS + 500 },
    });
    const result = await evaluateSelfTestRun(t.client, 'tbl', KEY, running(), START_MS + 1_000, {
      latencyBudgetMs: 5_000,
    });
    expect(result.channelResults.PUSH).toEqual({
      ok: true,
      ms: 400,
      delivered: false,
      reason: 'credentials verified, not delivered',
    });
  });

  it('a push that rang at least one device is a delivery', async () => {
    const t = table({
      PUSH: {
        sendState: 'SENT',
        completedAtMs: START_MS + 400,
        deviceSends: { ios: 'SENT', 'android-1': 'VALIDATED' },
      },
      SMS: { sendState: 'SENT', completedAtMs: START_MS + 500 },
    });
    const result = await evaluateSelfTestRun(t.client, 'tbl', KEY, running(), START_MS + 1_000, {
      latencyBudgetMs: 5_000,
    });
    expect(result.channelResults.PUSH).toEqual({ ok: true, ms: 400 });
  });
});
