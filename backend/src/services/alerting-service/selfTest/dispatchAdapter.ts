import type {
  DispatchIngressPort,
  DispatchReceived,
  NormalizeResult,
} from '../dispatches/dispatchIngressPort.js';

export const SELF_TEST_CHANNELS: readonly string[] = ['PUSH', 'SMS'];

export function buildSelfTestDispatch(testId: string): DispatchReceived {
  return {
    sourceSystem: 'SELF_TEST',
    incidentType: 'SELF_TEST',
    address: 'Self-test — no real address',
    crossStreets: 'N/A',
    unitsRequested: [],
    narrative: 'Synthetic self-test dispatch addressed only to the requesting member.',
    externalDispatchId: testId,
  };
}

function normalizeSelfTest(rawPayload: unknown): NormalizeResult {
  const testId =
    typeof rawPayload === 'object' &&
    rawPayload !== null &&
    typeof (rawPayload as Record<string, unknown>).testId === 'string'
      ? ((rawPayload as Record<string, unknown>).testId as string)
      : '';
  if (testId.length === 0) {
    return {
      ok: false,
      errors: [{ field: 'testId', message: 'testId is required and must be a non-empty string' }],
    };
  }
  return { ok: true, value: buildSelfTestDispatch(testId) };
}

export const selfTestAdapter: DispatchIngressPort = {
  sourceSystem: 'SELF_TEST',
  normalize: normalizeSelfTest,
};
