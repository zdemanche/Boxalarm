import { describe, expect, it, vi } from 'vitest';
import { emitEmf, emitOutcomeMetric, withLatency } from './index.js';

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

describe('withLatency', () => {
  it('emits Latency (Milliseconds) and Throughput on success', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(withLatency('Boxalarm/Test', 'GetItem', () => Promise.resolve(42))).resolves.toBe(
      42,
    );
    const payloads = logSpy.mock.calls.map(
      (c) => JSON.parse(c[0] as string) as Record<string, unknown>,
    );
    const latency = payloads.find((p) => 'Latency' in p) as {
      Latency: number;
      Operation: string;
      _aws: { CloudWatchMetrics: { Metrics: { Unit: string }[] }[] };
    };
    const throughput = payloads.find((p) => 'Throughput' in p) as {
      Throughput: number;
      Operation: string;
    };
    expect(latency.Operation).toBe('GetItem');
    expect(latency._aws.CloudWatchMetrics[0]?.Metrics[0]?.Unit).toBe('Milliseconds');
    expect(typeof latency.Latency).toBe('number');
    expect(throughput).toMatchObject({ Throughput: 1, Operation: 'GetItem' });
    logSpy.mockRestore();
  });

  it('emits Latency and Errors then rethrows on failure', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(
      withLatency('Boxalarm/Test', 'PutItem', () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    const payloads = logSpy.mock.calls.map(
      (c) => JSON.parse(c[0] as string) as Record<string, unknown>,
    );
    expect(payloads.some((p) => 'Latency' in p)).toBe(true);
    expect(payloads.some((p) => p.Errors === 1 && p.Operation === 'PutItem')).toBe(true);
    expect(payloads.some((p) => 'Throughput' in p)).toBe(false);
    logSpy.mockRestore();
  });
});
