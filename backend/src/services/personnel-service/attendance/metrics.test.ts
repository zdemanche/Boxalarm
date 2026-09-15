import { describe, expect, it, vi } from 'vitest';
import { emitAttendanceMetric } from './metrics.js';

interface EmfLine {
  readonly Reason?: string;
  readonly AttendanceRecorded?: number;
  readonly AttendanceFailed?: number;
  readonly _aws: { readonly CloudWatchMetrics: ReadonlyArray<{ readonly Dimensions: string[][] }> };
}

describe('emitAttendanceMetric', () => {
  it('emits both an undimensioned and a Reason-dimensioned metric on failure', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    emitAttendanceMetric('Failed', 'ValidationError');
    expect(logSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as EmfLine;
    expect(parsed.Reason).toBe('ValidationError');
    expect(parsed.AttendanceFailed).toBe(1);
    expect(parsed._aws.CloudWatchMetrics[0]?.Dimensions).toEqual([[], ['Reason']]);
    logSpy.mockRestore();
  });

  it('emits only the undimensioned metric on success', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    emitAttendanceMetric('Recorded');
    const parsed = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as EmfLine;
    expect(parsed.Reason).toBeUndefined();
    expect(parsed.AttendanceRecorded).toBe(1);
    expect(parsed._aws.CloudWatchMetrics[0]?.Dimensions).toEqual([[]]);
    logSpy.mockRestore();
  });
});
