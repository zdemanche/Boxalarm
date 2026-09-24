import type { InventoryRepository } from './types';

// No real @boxalarm/core-backed client wired into this screen yet (see ChecksStack's
// apiChecksRepository for the pattern this will follow once one is) — stands in for the GSI1
// self view / GET /api/v1/inventory/ppe/{memberId} responses.
export const mockInventoryRepository: InventoryRepository = {
  async getMyEquipment() {
    return [
      {
        assetId: 'eq-2',
        serialNumber: 'THERM-0092',
        assignedToType: 'MEMBER',
        assignedToId: 'MBR-0012',
        location: 'Station 1',
        lifecycleStatus: 'IN_SERVICE',
      },
    ];
  },

  async getMyPpe() {
    return [
      {
        ppeItemId: 'turnout-coat',
        itemType: 'turnout_coat',
        size: 'L',
        issueDate: '2020-05-01',
        nfpaExpiryDate: '2030-05-01',
        status: 'ISSUED',
      },
      {
        ppeItemId: 'helmet',
        itemType: 'helmet',
        size: 'M',
        issueDate: '2014-01-15',
        nfpaExpiryDate: '2024-01-15',
        status: 'EXPIRED',
      },
    ];
  },
};
