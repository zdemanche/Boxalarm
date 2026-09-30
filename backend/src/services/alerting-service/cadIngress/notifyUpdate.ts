import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { captureAWSv3Client } from 'aws-xray-sdk-core';
import { ALERTING_SDK_CLIENT_CONFIG } from '../awsClientConfig.js';
import { logError } from '../dispatches/logger.js';
import { emitCadMetric } from './metrics.js';
import type { CadUpdateNotice } from './updateNotifierHandler.js';

/**
 * Hands a durably-recorded CAD update to the notifier (updateNotifierHandler.ts) as an async
 * Lambda invoke. Never throws: the update is already recorded and shows on the dispatch; a
 * failed hand-off is counted (CadUpdatePushFailed, alarmed) and the ingress still answers.
 */

let client: LambdaClient | undefined;

/** Test seam. */
export function setLambdaClient(override: LambdaClient | undefined): void {
  client = override;
}

export async function notifyUpdate(notice: CadUpdateNotice): Promise<void> {
  const functionName = process.env.CAD_UPDATE_NOTIFIER_FUNCTION;
  try {
    if (!functionName) throw new Error('CAD_UPDATE_NOTIFIER_FUNCTION is not set');
    client ??= captureAWSv3Client(new LambdaClient(ALERTING_SDK_CLIENT_CONFIG));
    await client.send(
      new InvokeCommand({
        FunctionName: functionName,
        InvocationType: 'Event',
        Payload: Buffer.from(JSON.stringify(notice)),
      }),
    );
  } catch (error) {
    logError('cadIngress.update.handoffFailed', error, {
      dispatchId: notice.dispatchId,
      updateId: notice.updateId,
    });
    emitCadMetric('CadUpdatePushFailed', { Reason: 'HandoffFailed' });
  }
}
