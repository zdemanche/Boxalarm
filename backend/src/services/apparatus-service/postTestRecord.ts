import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import {
  PutCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import type { VerifiedPermissionsClient } from '@aws-sdk/client-verifiedpermissions';
import {
  extractTraceId,
  withAuthorization,
  type CedarPrincipalContext,
  type GuardEvent,
} from '@boxalarm/authz';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { emitOutcomeMetric } from '@boxalarm/metrics';
import { createApparatusRepository, type ApparatusRepository } from './apparatusRepository.js';
import { createDynamoClient, readApparatusTableConfig } from './dynamoClient.js';
import {
  buildTestDueItem,
  buildTestRecordItem,
  parseTestRecordItem,
  type TestResult,
  type TestType,
} from './testRecord.js';
import { apparatusNotFoundProblem, validationProblem } from './problemDetails.js';
import type { ValidationFieldError } from './problemDetails.js';

const METRIC_NAMESPACE = 'Boxalarm/Apparatus';
const TEST_TYPES = new Set<TestType>(['HOSE', 'LADDER', 'PUMP', 'AERIAL']);
const RESULTS = new Set<TestResult>(['PASS', 'FAIL']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

interface PostTestRecordDeps {
  readonly client: DynamoDBDocumentClient;
  readonly tableName: string;
  readonly apparatusRepository: ApparatusRepository;
  readonly now: () => string;
  readonly loggedAt: () => string;
}

interface ValidatedFields {
  readonly testType: TestType;
  readonly result: TestResult;
  readonly nextDueDate: string;
  readonly testDate: string;
}

function isValidIsoDate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ISO_DATE.test(value) &&
    !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  );
}

function validateFields(
  body: Record<string, unknown>,
  defaultTestDate: string,
):
  | { readonly ok: true; readonly value: ValidatedFields }
  | { readonly ok: false; readonly errors: readonly ValidationFieldError[] } {
  const errors: ValidationFieldError[] = [];

  const testType =
    typeof body.testType === 'string' && TEST_TYPES.has(body.testType as TestType)
      ? (body.testType as TestType)
      : undefined;
  if (!testType) {
    errors.push({ field: 'testType', message: 'must be one of HOSE, LADDER, PUMP, AERIAL' });
  }

  const result =
    typeof body.result === 'string' && RESULTS.has(body.result as TestResult)
      ? (body.result as TestResult)
      : undefined;
  if (!result) {
    errors.push({ field: 'result', message: 'must be one of PASS, FAIL' });
  }

  if (!isValidIsoDate(body.nextDueDate)) {
    errors.push({ field: 'nextDueDate', message: 'must be an ISO date (YYYY-MM-DD)' });
  }

  let testDate = defaultTestDate;
  if (body.testDate !== undefined) {
    if (!isValidIsoDate(body.testDate)) {
      errors.push({
        field: 'testDate',
        message: 'must be an ISO date (YYYY-MM-DD) when provided',
      });
    } else {
      testDate = body.testDate;
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      testType: testType as TestType,
      result: result as TestResult,
      nextDueDate: body.nextDueDate as string,
      testDate,
    },
  };
}

function isDueNotSuperseded(error: unknown): boolean {
  return (
    error instanceof TransactionCanceledException &&
    error.CancellationReasons?.[0]?.Code !== 'ConditionalCheckFailed' &&
    error.CancellationReasons?.[1]?.Code === 'ConditionalCheckFailed'
  );
}

function created(
  item: Record<string, unknown>,
  apparatusId: string,
  deptId: string,
): APIGatewayProxyResultV2 {
  return {
    statusCode: 201,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(parseTestRecordItem(item, apparatusId, deptId)),
  };
}

async function postTestRecord(
  event: GuardEvent,
  principal: CedarPrincipalContext,
  deps: PostTestRecordDeps,
): Promise<APIGatewayProxyResultV2> {
  const traceId = extractTraceId(event);
  const unitId = event.pathParameters?.unitId;
  if (!unitId) {
    return apparatusNotFoundProblem(traceId);
  }
  const deptId = toVerifiedDeptId(principal);

  let rawBody: Record<string, unknown>;
  try {
    rawBody = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};
  } catch (error) {
    console.error(
      JSON.stringify({
        event: 'apparatusTest.validation_failed',
        reason: 'MalformedJson',
        correlationId: traceId,
        deptId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return validationProblem(traceId, [{ field: 'body', message: 'must be valid JSON' }]);
  }

  const validation = validateFields(rawBody, deps.now());
  if (!validation.ok) {
    return validationProblem(traceId, validation.errors);
  }

  const apparatus = await deps.apparatusRepository.getApparatusByUnitId(deptId, unitId);
  if (!apparatus) {
    return apparatusNotFoundProblem(traceId);
  }

  const item = buildTestRecordItem(
    deptId,
    apparatus.apparatusId,
    validation.value,
    deps.loggedAt(),
  );
  const dueItem = buildTestDueItem(deptId, apparatus.apparatusId, validation.value);

  const logPutFailed = (error: unknown): void => {
    console.error(
      JSON.stringify({
        event: 'apparatusTest.put_failed',
        correlationId: traceId,
        deptId,
        apparatusId: apparatus.apparatusId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    emitOutcomeMetric(METRIC_NAMESPACE, 'TestRecordLogFailed');
  };

  try {
    await deps.client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: deps.tableName,
              Item: item,
              ConditionExpression: 'attribute_not_exists(sk)',
            },
          },
          {
            Put: {
              TableName: deps.tableName,
              Item: dueItem,
              ConditionExpression: 'attribute_not_exists(testDate) OR testDate <= :testDate',
              ExpressionAttributeValues: { ':testDate': validation.value.testDate },
            },
          },
        ],
      }),
    );
  } catch (error) {
    if (isDueNotSuperseded(error)) {
      console.warn(
        JSON.stringify({
          event: 'apparatusTest.due_not_superseded',
          correlationId: traceId,
          deptId,
          apparatusId: apparatus.apparatusId,
          testType: validation.value.testType,
          testDate: validation.value.testDate,
        }),
      );
      try {
        await deps.client.send(
          new PutCommand({
            TableName: deps.tableName,
            Item: item,
            ConditionExpression: 'attribute_not_exists(sk)',
          }),
        );
      } catch (fallbackError) {
        logPutFailed(fallbackError);
        throw fallbackError;
      }
      emitOutcomeMetric(METRIC_NAMESPACE, 'TestRecordLogged');
      return created(item, apparatus.apparatusId, deptId);
    }
    logPutFailed(error);
    throw error;
  }
  emitOutcomeMetric(METRIC_NAMESPACE, 'TestRecordLogged');

  return created(item, apparatus.apparatusId, deptId);
}

interface PostTestRecordOverrides {
  readonly client?: DynamoDBDocumentClient;
  readonly tableName?: string;
  readonly apparatusRepository?: ApparatusRepository;
  readonly now?: () => string;
  readonly loggedAt?: () => string;
  readonly authzClient?: VerifiedPermissionsClient;
}

function resolveDeps(overrides: PostTestRecordOverrides): PostTestRecordDeps {
  const client = overrides.client ?? createDynamoClient(process.env);
  const tableName = overrides.tableName ?? readApparatusTableConfig(process.env).tableName;
  return {
    client,
    tableName,
    apparatusRepository:
      overrides.apparatusRepository ?? createApparatusRepository(client, tableName),
    now: overrides.now ?? (() => new Date().toISOString().slice(0, 10)),
    loggedAt: overrides.loggedAt ?? (() => new Date().toISOString()),
  };
}

export function createPostTestRecordHandler(
  overrides: PostTestRecordOverrides = {},
): (event: GuardEvent) => Promise<APIGatewayProxyResultV2> {
  return withAuthorization(
    (event, principal) => postTestRecord(event, principal, resolveDeps(overrides)),
    {
      actionType: 'Boxalarm::Action',
      actionId: 'LogApparatusTestRecord',
      resourceType: 'Boxalarm::Apparatus',
      resourceId: (event) => event.pathParameters?.unitId ?? '',
      ...(overrides.authzClient !== undefined ? { client: overrides.authzClient } : {}),
    },
  );
}

export const handler = createPostTestRecordHandler();
