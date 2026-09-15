import { describe, expect, it, vi } from 'vitest';
import type { EventBridgeEvent } from 'aws-lambda';
import { classifyRecoveryEvent, handler } from './handler.js';
import type { CognitoRecoveryDetail } from './handler.js';

interface ParsedMetricLine {
  _aws: {
    CloudWatchMetrics: {
      Namespace: string;
      Dimensions: string[][];
      Metrics: { Name: string; Unit: string }[];
    }[];
  };
  service?: string;
  correlationId?: string;
  Reason?: string;
  [key: string]: unknown;
}

function buildEvent(
  detail: CognitoRecoveryDetail | undefined,
): EventBridgeEvent<'AWS API Call via CloudTrail', CognitoRecoveryDetail> {
  return {
    id: 'event-1',
    version: '0',
    account: '111122223333',
    time: '2026-09-14T00:00:00Z',
    region: 'us-east-1',
    resources: [],
    source: 'aws.cognito-idp',
    'detail-type': 'AWS API Call via CloudTrail',
    detail: detail as CognitoRecoveryDetail,
  };
}

function findMetricLine(logSpy: ReturnType<typeof vi.spyOn>, metricName: string): ParsedMetricLine {
  const line = logSpy.mock.calls
    .map((call) => call[0] as string)
    .find((l) => l.includes(`"${metricName}":1`));
  return JSON.parse(line ?? '{}') as ParsedMetricLine;
}

describe('classifyRecoveryEvent', () => {
  it('classifies ForgotPassword with no errorCode as RecoveryStarted', () => {
    expect(classifyRecoveryEvent({ eventName: 'ForgotPassword' })).toBe('RecoveryStarted');
  });

  it('classifies ConfirmForgotPassword with no errorCode as RecoveryCompleted', () => {
    expect(classifyRecoveryEvent({ eventName: 'ConfirmForgotPassword' })).toBe('RecoveryCompleted');
  });

  it('classifies ConfirmForgotPassword with an errorCode as RecoveryFailed', () => {
    expect(
      classifyRecoveryEvent({
        eventName: 'ConfirmForgotPassword',
        errorCode: 'CodeMismatchException',
      }),
    ).toBe('RecoveryFailed');
  });

  it('throws (fail-closed) when detail is missing', () => {
    expect(() => classifyRecoveryEvent(undefined)).toThrow();
  });

  it('throws (fail-closed) on an unrecognized eventName', () => {
    expect(() => classifyRecoveryEvent({ eventName: 'AdminDeleteUser' })).toThrow();
  });
});

describe('handler', () => {
  it('emits a well-formed RecoveryStarted EMF metric for ForgotPassword', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await handler(buildEvent({ eventName: 'ForgotPassword' }), {} as never, () => undefined);
    const parsed = findMetricLine(logSpy, 'RecoveryStarted');
    expect(parsed._aws.CloudWatchMetrics[0]?.Namespace).toBe('Boxalarm/CredentialRecovery');
    expect(parsed._aws.CloudWatchMetrics[0]?.Dimensions).toEqual([[]]);
    expect(parsed._aws.CloudWatchMetrics[0]?.Metrics[0]).toEqual({
      Name: 'RecoveryStarted',
      Unit: 'Count',
    });
    expect(parsed.RecoveryStarted).toBe(1);
    expect(parsed.service).toBe('platform-service');
    expect(parsed.correlationId).toBe('event-1');
  });

  it('emits a well-formed RecoveryCompleted EMF metric for ConfirmForgotPassword', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await handler(buildEvent({ eventName: 'ConfirmForgotPassword' }), {} as never, () => undefined);
    const parsed = findMetricLine(logSpy, 'RecoveryCompleted');
    expect(parsed._aws.CloudWatchMetrics[0]?.Namespace).toBe('Boxalarm/CredentialRecovery');
    expect(parsed._aws.CloudWatchMetrics[0]?.Dimensions).toEqual([[]]);
    expect(parsed._aws.CloudWatchMetrics[0]?.Metrics[0]).toEqual({
      Name: 'RecoveryCompleted',
      Unit: 'Count',
    });
    expect(parsed.RecoveryCompleted).toBe(1);
    expect(parsed.correlationId).toBe('event-1');
  });

  it('emits a well-formed RecoveryFailed EMF metric with a Reason dimension for a failed ConfirmForgotPassword', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await handler(
      buildEvent({ eventName: 'ConfirmForgotPassword', errorCode: 'CodeMismatchException' }),
      {} as never,
      () => undefined,
    );
    const parsed = findMetricLine(logSpy, 'RecoveryFailed');
    expect(parsed._aws.CloudWatchMetrics[0]?.Namespace).toBe('Boxalarm/CredentialRecovery');
    expect(parsed._aws.CloudWatchMetrics[0]?.Dimensions).toEqual([[], ['Reason']]);
    expect(parsed._aws.CloudWatchMetrics[0]?.Metrics[0]).toEqual({
      Name: 'RecoveryFailed',
      Unit: 'Count',
    });
    expect(parsed.RecoveryFailed).toBe(1);
    expect(parsed.Reason).toBe('CodeMismatchException');
    expect(parsed.correlationId).toBe('event-1');
  });

  it('throws, emits no recovery-outcome metric, but emits a RecoveryClassificationFailed failure metric with correlation id when event.detail is absent (fail-closed)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(handler(buildEvent(undefined), {} as never, () => undefined)).rejects.toThrow();
    const logged = logSpy.mock.calls.map((call) => call[0] as string).join('\n');
    expect(logged).not.toContain('RecoveryStarted');
    expect(logged).not.toContain('RecoveryCompleted');
    expect(logged).not.toContain('"RecoveryFailed":1');
    const parsed = findMetricLine(logSpy, 'RecoveryClassificationFailed');
    expect(parsed._aws.CloudWatchMetrics[0]?.Namespace).toBe('Boxalarm/CredentialRecovery');
    expect(parsed._aws.CloudWatchMetrics[0]?.Dimensions).toEqual([[], ['Reason']]);
    expect(parsed._aws.CloudWatchMetrics[0]?.Metrics[0]).toEqual({
      Name: 'RecoveryClassificationFailed',
      Unit: 'Count',
    });
    expect(parsed.correlationId).toBe('event-1');
    expect(parsed.Reason).toBe('Error');
  });

  it('throws (fail-closed) on an unrecognized eventName instead of a silent success', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      handler(buildEvent({ eventName: 'AdminDeleteUser' }), {} as never, () => undefined),
    ).rejects.toThrow();
  });

  it('logs the classification failure with context, correlation id, but never logs requestParameters (no PII)', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(
      handler(
        buildEvent({
          eventName: 'AdminDeleteUser',
          requestParameters: { username: 'member@example.com' },
        }),
        {} as never,
        () => undefined,
      ),
    ).rejects.toThrow();
    const logged = errorSpy.mock.calls.map((call) => call[0] as string).join('\n');
    expect(logged).not.toContain('member@example.com');
    expect(logged).toContain('AdminDeleteUser');
    const parsed = JSON.parse(errorSpy.mock.calls[0]?.[0] as string) as {
      correlationId?: string;
      service?: string;
    };
    expect(parsed.correlationId).toBe('event-1');
    expect(parsed.service).toBe('platform-service');
  });

  it('never logs requestParameters verbatim when a completed recovery carries an email/phone value', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await handler(
      buildEvent({
        eventName: 'ConfirmForgotPassword',
        requestParameters: { username: 'member@example.com' },
      }),
      {} as never,
      () => undefined,
    );
    const logged = logSpy.mock.calls.map((call) => call[0] as string).join('\n');
    expect(logged).not.toContain('member@example.com');
  });
});
