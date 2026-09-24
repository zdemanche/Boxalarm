import { createOutboxDrainHandler } from '@boxalarm/outbox';

export const handler = createOutboxDrainHandler('platform-service');
