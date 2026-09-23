import type { Handler, SQSEvent, SQSRecord } from 'aws-lambda';
import { handleInventoryReorderDue, type InventoryReorderDuePayload } from './index.js';

interface InventoryReorderDueEnvelope {
  readonly correlationId: string;
  readonly payload: InventoryReorderDuePayload;
}

function parseEnvelope(body: string): InventoryReorderDueEnvelope {
  const parsed = JSON.parse(body) as { detail?: unknown };
  const detail = parsed.detail;
  if (typeof detail !== 'object' || detail === null) {
    throw new Error('inventory.reorder.due message is missing detail');
  }
  const envelope = detail as {
    eventType?: unknown;
    correlationId?: unknown;
    payload?: {
      itemId?: unknown;
      itemName?: unknown;
      currentQty?: unknown;
      reorderThreshold?: unknown;
      deptId?: unknown;
    };
  };
  const payload = envelope.payload;
  if (
    envelope.eventType !== 'inventory.reorder.due' ||
    typeof envelope.correlationId !== 'string' ||
    envelope.correlationId.length === 0 ||
    !payload ||
    typeof payload.itemId !== 'string' ||
    typeof payload.itemName !== 'string' ||
    typeof payload.currentQty !== 'number' ||
    typeof payload.reorderThreshold !== 'number' ||
    typeof payload.deptId !== 'string'
  ) {
    throw new Error('inventory.reorder.due payload failed shape validation');
  }
  return {
    correlationId: envelope.correlationId,
    payload: {
      itemId: payload.itemId,
      itemName: payload.itemName,
      currentQty: payload.currentQty,
      reorderThreshold: payload.reorderThreshold,
      deptId: payload.deptId,
    },
  };
}

function logMalformed(error: unknown, messageId: string): void {
  console.error(
    JSON.stringify({
      event: 'notification.inventory_reorder_due.malformed',
      service: 'notification-service',
      reason: error instanceof Error ? error.constructor.name : 'UnknownError',
      message: error instanceof Error ? error.message : undefined,
      correlationId: messageId,
    }),
  );
}

function processRecord(record: SQSRecord): void {
  let envelope: InventoryReorderDueEnvelope;
  try {
    envelope = parseEnvelope(record.body);
  } catch (error) {
    logMalformed(error, record.messageId);
    throw error;
  }
  // TODO: E3-S3 — dedup on eventId once notification-service has a preference/delivery store to dedup against.
  handleInventoryReorderDue(envelope.payload, envelope.correlationId);
}

// async is load-bearing here: it converts processRecord's synchronous throw into a
// rejected Promise, which is what the Handler contract (and this file's own
// fail-closed/SQS-redelivery tests) rely on.
// eslint-disable-next-line @typescript-eslint/require-await
export const handler: Handler<SQSEvent, void> = async (event) => {
  for (const record of event.Records) {
    processRecord(record);
  }
};
