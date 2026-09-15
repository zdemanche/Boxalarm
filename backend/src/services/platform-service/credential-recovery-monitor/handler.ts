import type { EventBridgeEvent, Handler } from 'aws-lambda';

export interface CognitoRecoveryDetail {
  readonly eventName: string;
  readonly errorCode?: string;
  readonly requestParameters?: Record<string, unknown>;
}

type RecoveryOutcome =
  'RecoveryStarted' | 'RecoveryCompleted' | 'RecoveryFailed' | 'RecoveryClassificationFailed';

const SERVICE_NAME = 'platform-service';

export function classifyRecoveryEvent(detail: CognitoRecoveryDetail | undefined): RecoveryOutcome {
  if (!detail) {
    throw new Error('event.detail is required and was not set');
  }
  const { eventName, errorCode } = detail;
  if (errorCode) {
    if (eventName === 'ForgotPassword' || eventName === 'ConfirmForgotPassword') {
      return 'RecoveryFailed';
    }
    throw new Error(`Unrecognized credential-recovery eventName: ${String(eventName)}`);
  }
  if (eventName === 'ForgotPassword') {
    return 'RecoveryStarted';
  }
  if (eventName === 'ConfirmForgotPassword') {
    return 'RecoveryCompleted';
  }
  throw new Error(`Unrecognized credential-recovery eventName: ${String(eventName)}`);
}

export function emitRecoveryMetric(
  outcome: RecoveryOutcome,
  correlationId: string,
  reason?: string,
): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/CredentialRecovery',
            Dimensions: reason ? [[], ['Reason']] : [[]],
            Metrics: [{ Name: outcome, Unit: 'Count' }],
          },
        ],
      },
      service: SERVICE_NAME,
      correlationId,
      ...(reason ? { Reason: reason } : {}),
      [outcome]: 1,
    }),
  );
}

export const handler: Handler<
  EventBridgeEvent<'AWS API Call via CloudTrail', CognitoRecoveryDetail>,
  void
> =
  // eslint-disable-next-line @typescript-eslint/require-await -- Handler contract is async; this handler has no await today
  async (event) => {
    try {
      const outcome = classifyRecoveryEvent(event.detail);
      emitRecoveryMetric(outcome, event.id, event.detail?.errorCode);
    } catch (error) {
      const reason = error instanceof Error ? error.constructor.name : 'UnknownError';
      console.error(
        JSON.stringify({
          event: 'credential-recovery-monitor.classification-failed',
          service: SERVICE_NAME,
          correlationId: event.id,
          reason,
          message: error instanceof Error ? error.message : undefined,
          eventName: event.detail?.eventName,
        }),
      );
      emitRecoveryMetric('RecoveryClassificationFailed', event.id, reason);
      throw error;
    }
  };
