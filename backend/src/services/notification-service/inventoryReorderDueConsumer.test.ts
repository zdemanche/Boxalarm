import { describe, expect, it, vi } from 'vitest';
import { handleInventoryReorderDue } from './index.js';

describe('handleInventoryReorderDue stub (AC2 — routed to quartermaster/admin role via notification-service)', () => {
  it('logs a non-critical channel stub and never mentions alerting-service delivery', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    handleInventoryReorderDue(
      {
        itemId: 'GLOVES-L',
        itemName: 'Gloves (Large)',
        currentQty: 3,
        reorderThreshold: 5,
        deptId: 'NICHOLS',
      },
      'trace-1',
    );

    expect(logSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(logSpy.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(logged.event).toBe('notification.inventory_reorder_due.stub');
    expect(logged.channelClass).toBe('non-critical');
    expect(logged.itemId).toBe('GLOVES-L');
    expect(String(logged.message)).toContain('do not route via alerting-service');
    logSpy.mockRestore();
  });
});
