import { createDeliveryReceiptWebhookHandler } from './deliveryReceiptWebhookHandler.js';

export const handler = createDeliveryReceiptWebhookHandler({
  channel: 'sms',
  vendorLabel: 'SMS',
  secretHeaderName: 'x-sms-provider-secret',
  secretEnvVar: 'SMS_PROVIDER_WEBHOOK_SECRET',
  allowedStatuses: ['delivered', 'failed'],
  metricPrefix: 'Sms',
  logPrefix: 'alerting.receipts.sms',
});
