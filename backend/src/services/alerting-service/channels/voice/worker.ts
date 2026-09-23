// TODO: E1-S2 — assumes alerting-voice-queue.fifo + paired DLQ (maxReceiveCount: 3), RawMessageDelivery=true, ALERTING_TABLE_NAME/VOICE_PROVIDER_ENDPOINT_URL/VOICE_PROVIDER_SECRET_ID env vars, and an execution role scoped to the alerting-service table only.
// TODO: E8-S11 — assumes a CloudWatch alarm on this queue's DLQ that pages on-call immediately.
import { createChannelWorkerHandler } from '../deliverChannelMessage.js';

export const handler = createChannelWorkerHandler('voice');
