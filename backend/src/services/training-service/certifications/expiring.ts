import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  extractTraceId,
  serviceUnavailableProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { queryCertificationsDueInMonth } from '../certificationRepository.js';
import {
  monthPartitionsForScan,
  readCertExpiryLeadDays,
  selectWithinLeadTime,
} from '../certificationExpiryScanner/configReader.js';
import { createDynamoClient } from '../dynamoClient.js';

const METRIC_NAMESPACE = 'Boxalarm/training';

async function expiringCertificationsInner(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const deptId = toVerifiedDeptId(principal);

  try {
    const client = createDynamoClient();
    const now = new Date();
    const leadDays = await readCertExpiryLeadDays(client, process.env, deptId, traceId);
    const monthPartitions = monthPartitionsForScan(now, leadDays);
    const results = await Promise.all(
      monthPartitions.map((yearMonth) =>
        queryCertificationsDueInMonth(client, process.env, {
          deptId,
          yearMonth,
          correlationId: traceId,
        }),
      ),
    );
    const dueRecords = selectWithinLeadTime(results.flat(), now, leadDays);

    emitOutcomeMetric(METRIC_NAMESPACE, 'ExpiringCertificationsViewed');
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(dueRecords),
    };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'certification.expiring.unhandled',
        service: 'training',
        reason: error instanceof Error ? error.constructor.name : 'UnknownError',
        correlationId: traceId,
        deptId,
      }),
    );
    emitOutcomeMetric(METRIC_NAMESPACE, 'ExpiringCertificationsFailed');
    return serviceUnavailableProblem(traceId);
  }
}

export const handler = withAuthorization(expiringCertificationsInner, {
  actionType: 'Training',
  actionId: 'ViewExpiringCertifications',
  resourceType: 'Boxalarm::Department',
  resourceId: (event) => event.requestContext.authorizer?.lambda?.deptId ?? '',
});
