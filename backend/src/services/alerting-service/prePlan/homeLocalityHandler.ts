import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { withAuthorization, type GuardEvent } from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { createDynamoClient, readAlertingConfig } from '../eligibility/dynamoClient.js';
import { loadHomeLocality } from './locality.js';

/**
 * GET /api/v1/alerting/home-locality — the department's home towns and villages, for the
 * manual dispatch entry's required locality choice (web and mobile). Same authorization as
 * viewing an alert. Never fails the form: an unreadable config degrades to an empty list, and
 * the form then offers only "Other town" (a typed town name).
 */
export function createHomeLocalityHandler(
  deps: { authzClient?: VerifiedPermissionsClient; docClient?: DynamoDBDocumentClient } = {},
): (event: GuardEvent) => Promise<APIGatewayProxyResultV2> {
  return withAuthorization(
    async (_event, principal) => {
      const deptId = toVerifiedDeptId(principal);
      const home = await loadHomeLocality(
        createDynamoClient(process.env, deps.docClient),
        readAlertingConfig(process.env).tableName,
        deptId,
        process.env,
        'form',
      );
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'private, max-age=300' },
        body: JSON.stringify({
          towns: home.names,
          zips: [...home.zips],
          state: home.state,
        }),
      };
    },
    {
      actionType: 'Boxalarm::Action',
      actionId: 'ViewAlertDetail',
      resourceType: 'Boxalarm::Department',
      resourceId: (event) =>
        toVerifiedDeptId({ deptId: event.requestContext.authorizer.lambda?.deptId ?? '' }),
      ...(deps.authzClient ? { client: deps.authzClient } : {}),
    },
  );
}

export const handler = createHomeLocalityHandler();
