import { describe, expect, it, vi } from 'vitest';
import { emitAuthzMetric, emitInvocationMetric } from './metrics.js';

describe('emitAuthzMetric', () => {
  it('emits an EMF-shaped allow metric with a single undimensioned dimension set', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    emitAuthzMetric('Allowed');
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as {
      AuthzAllowed: number;
      _aws: { CloudWatchMetrics: { Dimensions: string[][] }[] };
    };
    expect(parsed.AuthzAllowed).toBe(1);
    expect(parsed._aws.CloudWatchMetrics[0]?.Dimensions).toEqual([[]]);
    logSpy.mockRestore();
  });

  it('adds a Reason dimension set to a deny metric so an outage is separable from a role denial', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    emitAuthzMetric('Denied', 'AuthzUnavailableError');
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as {
      AuthzDenied: number;
      Reason: string;
      _aws: { CloudWatchMetrics: { Dimensions: string[][] }[] };
    };
    expect(parsed.AuthzDenied).toBe(1);
    expect(parsed.Reason).toBe('AuthzUnavailableError');
    expect(parsed._aws.CloudWatchMetrics[0]?.Dimensions).toEqual([[], ['Reason']]);
    logSpy.mockRestore();
  });
});

describe('emitInvocationMetric', () => {
  it('fires unconditionally with no threshold dimension, for the export/disposal alarm-on-invocation requirement', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    emitInvocationMetric('PlatformExportInvoked');
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as {
      PlatformExportInvoked: number;
    };
    expect(parsed.PlatformExportInvoked).toBe(1);
    logSpy.mockRestore();
  });
});
