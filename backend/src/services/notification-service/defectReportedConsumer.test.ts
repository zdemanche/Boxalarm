import { describe, expect, it, vi } from 'vitest';
import { handleApparatusDefectReported } from './index.js';

describe('handleApparatusDefectReported stub', () => {
  it('logs a non-critical channel stub and never mentions alerting-service delivery', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    handleApparatusDefectReported(
      {
        defectId: 'DEF-1',
        apparatusId: 'APP-E1',
        unitLabel: 'E1',
        reportedByMemberId: 'MBR-1',
        severity: 'MAJOR',
        outOfService: false,
        deptId: 'NICHOLS',
      },
      'trace-1',
    );

    expect(logSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(logged.channelClass).toBe('non-critical');
    expect(String(logged.message)).toContain('do not route via the alerting plane');
    logSpy.mockRestore();
  });
});
