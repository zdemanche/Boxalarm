import { createOutboxDrainHandler } from '@boxalarm/outbox';

export const handler = createOutboxDrainHandler('incident-service');
