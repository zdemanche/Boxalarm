import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { getDocClient, readPersonnelTableConfig } from './dynamoClient.js';
import {
  completeShiftAttendance,
  findEndedShiftsWithClaims,
  zeroLosapCalculator,
  type CompleteShiftOutcome,
  type LosapPointsCalculator,
} from './completeShiftAttendance.js';

const METRIC_NAMESPACE = 'Boxalarm/PersonnelShiftAttendance';

export interface ShiftCompletionPayload {
  readonly deptId: string;
  /** When set, complete only this shift. When omitted, sweep all ended claimed shifts for the dept. */
  readonly shiftId?: string;
  readonly asOf?: number;
}

export interface CompletionHandlerDeps {
  readonly losapCalculator?: LosapPointsCalculator;
}

function isShiftCompletionPayload(value: unknown): value is ShiftCompletionPayload {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.deptId === 'string' &&
    (candidate.shiftId === undefined || typeof candidate.shiftId === 'string') &&
    (candidate.asOf === undefined || typeof candidate.asOf === 'number')
  );
}

function logError(
  event: string,
  error: unknown,
  correlationId: string,
  extra: Record<string, unknown> = {},
): void {
  console.error(
    JSON.stringify({
      event,
      service: 'personnel-service',
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      message: error instanceof Error ? error.message : undefined,
      correlationId,
      ...extra,
    }),
  );
}

export interface ShiftCompletionResult {
  readonly outcomes: ReadonlyArray<{
    readonly shiftId: string;
    readonly outcome: CompleteShiftOutcome;
  }>;
}

export const handler = async (
  payload: unknown,
  deps: CompletionHandlerDeps = {},
): Promise<ShiftCompletionResult> => {
  if (!isShiftCompletionPayload(payload)) {
    const error = new Error('shift completion payload failed shape validation');
    logError('shifts.completion.malformed_payload', error, 'unknown');
    throw error;
  }

  const deptId = toVerifiedDeptId({ deptId: payload.deptId });
  const now = payload.asOf ?? Math.floor(Date.now() / 1000);
  const { tableName } = readPersonnelTableConfig(process.env);
  const doc = getDocClient(process.env);
  const losapCalculator = deps.losapCalculator ?? zeroLosapCalculator;
  const correlationId = `${deptId}#${payload.shiftId ?? 'sweep'}#${now}`;

  let shiftIds: readonly string[];
  try {
    shiftIds =
      payload.shiftId !== undefined
        ? [payload.shiftId]
        : await findEndedShiftsWithClaims(doc, tableName, deptId, now);
  } catch (error) {
    logError('shifts.completion.find_failed', error, correlationId);
    emitOutcomeMetric(METRIC_NAMESPACE, 'CompletionFailed', 'DynamoDbUnavailable');
    throw error;
  }

  const outcomes: ShiftCompletionResult['outcomes'][number][] = [];
  for (const shiftId of shiftIds) {
    try {
      const outcome = await completeShiftAttendance(doc, tableName, deptId, shiftId, {
        now,
        losapCalculator,
      });
      outcomes.push({ shiftId, outcome });
      if (outcome.kind === 'COMPLETED') {
        emitOutcomeMetric(METRIC_NAMESPACE, 'AttendanceRecorded');
      }
    } catch (error) {
      logError('shifts.completion.write_failed', error, `${deptId}#${shiftId}`);
      emitOutcomeMetric(METRIC_NAMESPACE, 'CompletionFailed', 'DynamoDbUnavailable');
      throw error;
    }
  }

  return { outcomes };
};
