import { createDeliveryReceiptWebhookHandler } from './deliveryReceiptWebhookHandler.js';

export const handler = createDeliveryReceiptWebhookHandler({
  channel: 'push',
  vendorLabel: 'Push',
  secretHeaderName: 'x-push-provider-secret',
  secretEnvVar: 'PUSH_PROVIDER_WEBHOOK_SECRET',
  allowedStatuses: ['delivered', 'opened', 'failed'],
  openedStatus: 'opened',
  metricPrefix: 'Push',
  logPrefix: 'alerting.receipts.push',
});
