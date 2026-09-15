import { describe, expect, it, vi } from 'vitest';
import { emitEmf, emitOutcomeMetric } from './index.js';

describe('emitEmf', () => {
  it('logs an EMF-shaped payload carrying the given metric value and dimensions', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    emitEmf('Boxalarm/Test', 'ThingCount', 3, [[]], {});
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as {
      ThingCount: number;
      _aws: { CloudWatchMetrics: { Namespace: string; Dimensions: string[][] }[] };
    };
    expect(parsed.ThingCount).toBe(3);
    expect(parsed._aws.CloudWatchMetrics[0]?.Namespace).toBe('Boxalarm/Test');
    expect(parsed._aws.CloudWatchMetrics[0]?.Dimensions).toEqual([[]]);
    logSpy.mockRestore();
  });
});

describe('emitOutcomeMetric', () => {
  it('emits a plain [] dimension set with count 1 when no reason is given', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    emitOutcomeMetric('Boxalarm/Test', 'Created');
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as {
      Created: number;
      _aws: { CloudWatchMetrics: { Dimensions: string[][] }[] };
    };
    expect(parsed.Created).toBe(1);
    expect(parsed._aws.CloudWatchMetrics[0]?.Dimensions).toEqual([[]]);
    logSpy.mockRestore();
  });

  it('emits both [] and [Reason] dimension sets when a reason is given, so a plain rate alarm still resolves', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    emitOutcomeMetric('Boxalarm/Test', 'Failed', 'ConditionalCheckFailed');
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as {
      Reason: string;
      _aws: { CloudWatchMetrics: { Dimensions: string[][] }[] };
    };
    expect(parsed.Reason).toBe('ConditionalCheckFailed');
    expect(parsed._aws.CloudWatchMetrics[0]?.Dimensions).toEqual([[], ['Reason']]);
    logSpy.mockRestore();
  });
});
