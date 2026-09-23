import { describe, expect, it, vi } from 'vitest';
import { handleApparatusTestDue } from './index.js';

describe('handleApparatusTestDue stub', () => {
  it('logs a non-critical channel stub and never mentions alerting-service delivery', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    handleApparatusTestDue(
      { apparatusId: 'APP-E1', testType: 'HOSE', dueDate: '2027-05-01' },
      'trace-1',
    );

    expect(logSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(logged.channelClass).toBe('non-critical');
    expect(String(logged.message)).toContain('do not route via the alerting plane');
    logSpy.mockRestore();
  });
});
