import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  extractTraceId,
  notFoundProblem,
  serviceUnavailableProblem,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';
import { logError } from '../dispatches/logger.js';
import { getSelfTestRun } from './selfTestRunRepository.js';
import { evaluateSelfTestRun, SELF_TEST_RESULT_TIMEOUT_MS } from './evaluateSelfTestRun.js';

/**
 * A member's self-test passes when every channel's worker recorded the page SENT within this
 * window of the trigger - the same window the app polls for. The canary holds the real N1
 * budget (canary/handler.ts).
 */
export const SELF_TEST_LATENCY_BUDGET_MS = SELF_TEST_RESULT_TIMEOUT_MS;

async function getSelfTest(
  event: GuardEvent,
  principal: CedarPrincipalContext,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const testId = event.pathParameters?.testId;
  if (!testId) {
    return notFoundProblem(traceId, 'testId path parameter is required');
  }

  const deptId = toVerifiedDeptId(principal);
  const memberId = principal.sub;

  let tableName: string;
  let client: ReturnType<typeof createDynamoClient>;
  try {
    tableName = readAlertingConfig(process.env).tableName;
    client = createDynamoClient(process.env);
  } catch (error) {
    logError('selfTest.get.configError', error, { traceId, deptId, memberId, testId });
    return serviceUnavailableProblem(traceId);
  }

  let item: Record<string, unknown> | undefined;
  try {
    item = await getSelfTestRun(client, tableName, deptId, memberId, testId);
  } catch (error) {
    logError('selfTest.get.readFailed', error, { traceId, deptId, memberId, testId });
    return serviceUnavailableProblem(traceId);
  }

  if (!item) {
    return notFoundProblem(traceId, `self-test run ${testId} was not found`);
  }

  // PASS/FAIL comes from the workers' receipts (design review C3), decided here the first time
  // the member polls after they land.
  let evaluated;
  try {
    evaluated = await evaluateSelfTestRun(
      client,
      tableName,
      { deptId, memberId, testId },
      item,
      Date.now(),
      {
        latencyBudgetMs: SELF_TEST_LATENCY_BUDGET_MS,
      },
    );
  } catch (error) {
    logError('selfTest.get.evaluateFailed', error, { traceId, deptId, memberId, testId });
    return serviceUnavailableProblem(traceId);
  }

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      testId: item.testId,
      runAt: item.runAt,
      channelsTested: item.channelsTested,
      channelResults: evaluated.channelResults,
      overallResult: evaluated.overallResult,
      ...(evaluated.eligibilityReason ? { eligibilityReason: evaluated.eligibilityReason } : {}),
    }),
  };
}

export const handler = withAuthorization(getSelfTest, {
  actionType: 'Boxalarm::Action',
  actionId: 'SelfTestAlertPath',
  resourceType: 'Boxalarm::Member',
  resourceId: (event) => event.requestContext.authorizer?.lambda?.sub ?? '',
});
