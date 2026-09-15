import type { DynamoDBRecord, DynamoDBStreamHandler } from 'aws-lambda';
import { unmarshall } from '@aws-sdk/util-dynamodb';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { createDynamoDocClient, readPersonnelServiceConfig } from '../awsClients.js';
import { flipEligibilityOnCertExpired } from '../quals/repository.js';
import type { CertStatus } from '../quals/eligibility.js';

const TERMINAL_CERT_STATUSES: readonly CertStatus[] = ['EXPIRED', 'REVOKED'];

function emitEligibilityFlippedMetric(count: number): void {
  if (count === 0) {
    return;
  }
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/PersonnelService',
            Dimensions: [[]],
            Metrics: [{ Name: 'EligibilityFlipped', Unit: 'Count' }],
          },
        ],
      },
      EligibilityFlipped: count,
    }),
  );
}

function emitEligibilityFlipFailedMetric(reason: string): void {
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: 'Boxalarm/PersonnelService',
            Dimensions: [[], ['Reason']],
            Metrics: [{ Name: 'EligibilityFlipFailed', Unit: 'Count' }],
          },
        ],
      },
      Reason: reason,
      EligibilityFlipFailed: 1,
    }),
  );
}

function parseCertExpiredTransition(record: DynamoDBRecord) {
  const newImage = record.dynamodb?.NewImage;
  if (!newImage) {
    return undefined;
  }
  const item = unmarshall(newImage as Record<string, never>) as Record<string, unknown>;
  const oldImage = record.dynamodb?.OldImage;
  const previous = oldImage
    ? (unmarshall(oldImage as Record<string, never>) as Record<string, unknown>)
    : undefined;

  if (
    item.entityType !== 'CERTIFICATION' ||
    !TERMINAL_CERT_STATUSES.includes(item.status as CertStatus)
  ) {
    return undefined;
  }
  if (TERMINAL_CERT_STATUSES.includes(previous?.status as CertStatus)) {
    return undefined;
  }

  const { pk } = item as Record<string, string>;
  const certId = item.certId;
  if (typeof pk !== 'string' || typeof certId !== 'string') {
    return undefined;
  }
  const parts = pk.split('#');
  const deptId = parts[1];
  const memberId = parts[3];
  if (parts.length !== 4 || parts[0] !== 'DEPT' || parts[2] !== 'MEMBER' || !deptId || !memberId) {
    return undefined;
  }
  return { deptId, memberId, certId, status: item.status as CertStatus };
}

export const handler: DynamoDBStreamHandler = async (event) => {
  const config = readPersonnelServiceConfig(process.env);
  const client = createDynamoDocClient();
  const batchItemFailures: { itemIdentifier: string }[] = [];

  await Promise.allSettled(
    event.Records.map(async (record) => {
      let transition: ReturnType<typeof parseCertExpiredTransition>;
      try {
        transition = parseCertExpiredTransition(record);
      } catch (error) {
        console.error(
          JSON.stringify({
            event: 'personnel.certExpiredReactor.malformedRecord',
            service: 'personnel-service',
            eventId: record.eventID,
            reason: error instanceof Error ? error.constructor.name : 'UnknownError',
            message: error instanceof Error ? error.message : undefined,
          }),
        );
        return;
      }
      if (!transition) {
        return;
      }

      try {
        const flipped = await flipEligibilityOnCertExpired(
          client,
          config.tableName,
          toVerifiedDeptId({ deptId: transition.deptId }),
          transition.memberId,
          transition.certId,
          transition.status,
          record.eventID ?? transition.certId,
        );
        emitEligibilityFlippedMetric(flipped.length);
      } catch (error) {
        const reason = error instanceof Error ? error.constructor.name : 'UnknownError';
        console.error(
          JSON.stringify({
            event: 'personnel.certExpiredReactor.flipFailed',
            service: 'personnel-service',
            deptId: transition.deptId,
            memberId: transition.memberId,
            certId: transition.certId,
            reason,
            message: error instanceof Error ? error.message : undefined,
          }),
        );
        emitEligibilityFlipFailedMetric(reason);
        if (record.dynamodb?.SequenceNumber) {
          batchItemFailures.push({ itemIdentifier: record.dynamodb.SequenceNumber });
        }
      }
    }),
  );

  return { batchItemFailures };
};
