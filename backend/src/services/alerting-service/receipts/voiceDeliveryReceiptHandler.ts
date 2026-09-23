import { createDeliveryReceiptWebhookHandler } from './deliveryReceiptWebhookHandler.js';

export const handler = createDeliveryReceiptWebhookHandler({
  channel: 'voice',
  vendorLabel: 'Voice',
  secretHeaderName: 'x-voice-provider-secret',
  secretEnvVar: 'VOICE_PROVIDER_WEBHOOK_SECRET',
  allowedStatuses: ['delivered', 'failed'],
  metricPrefix: 'Voice',
  logPrefix: 'alerting.receipts.voice',
});
