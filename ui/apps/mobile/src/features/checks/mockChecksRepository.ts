import type { Apparatus, ChecklistTemplate, ChecksRepository } from './types';

const APPARATUS: Apparatus[] = [
  { apparatusId: 'APP-ENGINE-2', unitId: 'ENGINE-2', type: 'ENGINE', status: 'IN_SERVICE' },
  { apparatusId: 'APP-LADDER-1', unitId: 'LADDER-1', type: 'LADDER', status: 'IN_SERVICE' },
  { apparatusId: 'APP-TANKER-1', unitId: 'TANKER-1', type: 'TANKER', status: 'OUT_OF_SERVICE' },
];

const TEMPLATE: ChecklistTemplate = {
  templateId: 'CT-01',
  name: 'Engine daily check',
  items: [
    { code: 'TIRES', label: 'Tires and wheels', requiresPhoto: false },
    { code: 'FLUIDS', label: 'Fluid levels', requiresPhoto: false },
    { code: 'LIGHTS', label: 'Lights and sirens', requiresPhoto: false },
    { code: 'HOSE', label: 'Hose bed and connections', requiresPhoto: false },
    { code: 'SCBA', label: 'SCBA units present and charged', requiresPhoto: false },
  ],
};

// No backend access exists yet - stands in for @boxalarm/core's offline-sync-backed client.
// submitChecklistRun/submitDefect resolve immediately (no artificial delay), matching the
// optimistic local-first contract N4.2 requires: no step waits on a network round trip.
export const mockChecksRepository: ChecksRepository = {
  async getApparatus() {
    return APPARATUS;
  },

  async getChecklistTemplate() {
    return TEMPLATE;
  },

  async submitChecklistRun() {
    return undefined;
  },

  async submitDefect() {
    return undefined;
  },
};
