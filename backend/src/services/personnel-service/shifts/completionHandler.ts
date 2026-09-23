import { toVerifiedDeptId, type VerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { getDocClient, readPersonnelTableConfig } from './dynamoClient.js';
import {
  completeShiftAttendance,
  findEndedShiftsWithClaims,
  zeroLosapCalculator,
  type CompleteShiftOutcome,
  type LosapPointsCalculator,
} from './completeShiftAttendance.js';

const METRIC_NAMESPACE = 'Boxalarm/personnel-shift-attendance';

export interface ShiftCompletionPayload {
  readonly deptId: string;
  /** When set, complete only this shift. When omitted, sweep all ended claimed shifts for the dept. */
  readonly shiftId?: string;
  /** Epoch milliseconds (matches DUTY_SHIFT.startAt/endAt). Defaults to Date.now() when omitted. */
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

  let deptId: VerifiedDeptId;
  try {
    deptId = toVerifiedDeptId({ deptId: payload.deptId });
  } catch (error) {
    logError('shifts.completion.invalid_dept', error, 'unknown');
    emitOutcomeMetric(METRIC_NAMESPACE, 'CompletionFailed', 'InvalidDeptId');
    throw error;
  }
  const now = payload.asOf ?? Date.now();
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
      } else if (outcome.kind === 'ATTENDANCE_CONFLICT') {
        // A genuine attendance-record key collision, not a duplicate completion — meter and log
        // distinctly so it never silently reads as success (PR #150 review, finding #2).
        logError(
          'shifts.completion.attendance_conflict',
          new Error(`attendance key collision completing shift ${shiftId}`),
          `${deptId}#${shiftId}`,
        );
        emitOutcomeMetric(METRIC_NAMESPACE, 'CompletionFailed', 'AttendanceConflict');
      } else if (outcome.kind === 'SKIPPED_TOO_MANY_CLAIMS') {
        logError(
          'shifts.completion.too_many_claims',
          new Error(`shift ${shiftId} has more claimed positions than one transaction supports`),
          `${deptId}#${shiftId}`,
          { claimedCount: outcome.claimedCount, maxSupported: outcome.maxSupported },
        );
        emitOutcomeMetric(METRIC_NAMESPACE, 'CompletionFailed', 'TooManyClaimedPositions');
      }
    } catch (error) {
      // One malformed/failing shift must not abort every remaining shift in this invocation
      // (PR #150 review, finding #4) — record the failure and continue the sweep.
      logError('shifts.completion.write_failed', error, `${deptId}#${shiftId}`);
      emitOutcomeMetric(METRIC_NAMESPACE, 'CompletionFailed', 'DynamoDbUnavailable');
      outcomes.push({
        shiftId,
        outcome: { kind: 'FAILED', reason: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  const allShiftsFailed =
    shiftIds.length > 0 && outcomes.every((entry) => entry.outcome.kind === 'FAILED');
  if (allShiftsFailed) {
    const error = new Error(
      `all ${shiftIds.length} shift(s) failed attendance completion in this invocation`,
    );
    logError('shifts.completion.all_failed', error, correlationId, { shiftCount: shiftIds.length });
    emitOutcomeMetric(METRIC_NAMESPACE, 'CompletionFailed', 'AllShiftsFailed');
    throw error;
  }

  return { outcomes };
};
