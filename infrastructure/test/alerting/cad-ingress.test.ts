import { beforeEach, describe, expect, it } from "vitest";
import {
  CAD_WEBHOOK_KEY_THROTTLE,
  CAD_WEBHOOK_PATH,
  CadIngress,
} from "../../components/alerting/cad-ingress";
import { ServiceLogGroup } from "../../components/observability/service-log-group";
import {
  ACCOUNT_ID,
  BOUNDARY_ARN,
  CMK_ARN,
  TABLE_ARN,
  TOPIC_ARN,
  alarmByName,
  installMocks,
  isGranted,
  lambdaByName,
  lambdaEnv,
  resourcesOfType,
  settle,
  statementsForRole,
  type PolicyStatement,
} from "./mock-harness";

const PAGE = "arn:aws:sns:us-east-1:123456789012:boxalarm-dev-alerting-page";
const OPS = "arn:aws:sns:us-east-1:123456789012:boxalarm-dev-chief-notifications";
const CREW_FIFO = "arn:aws:sns:us-east-1:123456789012:boxalarm-dev-alerting-topic.fifo";
const WEBHOOK_FN = "boxalarm-dev-alerting-cad-webhook";
const EMAIL_FN = "boxalarm-dev-alerting-cad-email";
const COPY_FN = "boxalarm-dev-alerting-cad-source-copy-consumer";
const NOTIFIER_FN = "boxalarm-dev-alerting-cad-update-notifier";
const SWEEP_FN = "boxalarm-dev-alerting-cad-update-sweep";
const PLATFORM_TABLE = "arn:aws:dynamodb:us-east-1:123456789012:table/boxalarm-dev-platform-table";

beforeEach(() => {
  installMocks();
});

async function build(emailDomain?: string, webhookAllowedCidrs?: string[]): Promise<void> {
  new CadIngress("cad-ingress", {
    env: "dev",
    deptId: "nichols-fd",
    alertingTableArn: TABLE_ARN,
    alertingCmkArn: CMK_ARN,
    alertingTableName: "boxalarm-dev-alerting-table",
    alertingTopicArn: TOPIC_ARN,
    busName: "boxalarm-dev-platform-bus",
    pageTopicArn: PAGE,
    opsTopicArn: OPS,
    logGroup: new ServiceLogGroup("alerting-lg", { env: "dev", serviceName: "alerting-service" }),
    permissionsBoundaryArn: BOUNDARY_ARN,
    ...(emailDomain !== undefined ? { emailDomain } : {}),
    ...(webhookAllowedCidrs ? { webhookAllowedCidrs } : {}),
  });
  await settle();
  await settle();
}

function asArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value];
}

function touchesTable(statements: PolicyStatement[], tableArn: string): boolean {
  return statements.some(
    (s) =>
      s.Effect === "Allow" &&
      asArray(s.Resource).some((r) => r === "*" || r.startsWith(tableArn)) &&
      asArray(s.Action).some((a) => a.startsWith("dynamodb:") || a === "*"),
  );
}

describe("CadIngress IAM: alerting boundary, never a LOB table", { timeout: 30_000 }, () => {
  it.each([WEBHOOK_FN, EMAIL_FN, COPY_FN, NOTIFIER_FN, SWEEP_FN])(
    "%s runs under the alerting permissions boundary with no platform/incident grant",
    async (fn) => {
      await build("ingress.nichols.example.org");
      const role = resourcesOfType("aws:iam/role:Role").find((r) => r.inputs.name === fn);
      expect(role?.inputs.permissionsBoundary).toBe(BOUNDARY_ARN);
      const statements = statementsForRole(fn);
      expect(touchesTable(statements, PLATFORM_TABLE)).toBe(false);
      expect(
        statements.some((s) => asArray(s.Resource).some((r) => /incident|platform-table/.test(r))),
      ).toBe(false);
      // Every DynamoDB grant is on the alerting table and partition-scoped.
      for (const s of statements.filter((st) =>
        asArray(st.Action).some((a) => a.startsWith("dynamodb:")),
      )) {
        expect(asArray(s.Resource)).toEqual([TABLE_ARN]);
        expect(s.Condition?.["ForAllValues:StringLike"]?.["dynamodb:LeadingKeys"]).toBeDefined();
      }
    },
  );

  it("the webhook Lambda reads only the CAD webhook secrets and cannot write them", async () => {
    await build();
    const statements = statementsForRole(WEBHOOK_FN);
    const secretArn = `arn:aws:secretsmanager:us-east-1:${ACCOUNT_ID}:secret:boxalarm-dev-cad-webhook/*`;
    expect(isGranted(statements, "secretsmanager:GetSecretValue", secretArn)).toBe(true);
    expect(isGranted(statements, "secretsmanager:PutSecretValue", () => true)).toBe(false);
    expect(isGranted(statements, "secretsmanager:GetSecretValue", "*")).toBe(false);
  });

  it("the ingress writers are scoped to the dispatch transaction, replay markers and the copy", async () => {
    await build();
    const byAction = (sid: string) =>
      statementsForRole(WEBHOOK_FN).find((s) => s.Sid === sid)?.Condition?.[
        "ForAllValues:StringLike"
      ]?.["dynamodb:LeadingKeys"];
    expect(byAction("CadSourceCopyRead")).toEqual(["DEPT#*#CAD_INGRESS"]);
    expect(byAction("CadReplayMarkers")).toEqual(["DEPT#*#CAD_REPLAY#*"]);
    expect(byAction("CadDispatchWrite")).toEqual([
      "DEPT#*#DISPATCH_IDEMPOTENCY#*",
      "DEPT#*#DISPATCH#*",
      "DEPT#*#OUTBOX",
      "DEPT#*#CAD_UPDATE_PENDING",
    ]);
    // No Query/Scan/Publish: the webhook cannot run a fan-out or read receipts. (UpdateItem is
    // granted on DISPATCH#* for recording a CAD update on the DISPATCH_ALERT.)
    const actions = statementsForRole(WEBHOOK_FN).flatMap((s) => asArray(s.Action));
    for (const forbidden of ["dynamodb:Query", "dynamodb:Scan", "sns:Publish"]) {
      expect(actions).not.toContain(forbidden);
    }
  });

  it("the copy consumer writes only the CAD_INGRESS partition and consumes only its queue", async () => {
    await build();
    const statements = statementsForRole(COPY_FN);
    const write = statements.find((s) => s.Sid === "CadSourceCopyWrite");
    expect(write?.Action).toEqual(["dynamodb:PutItem"]);
    expect(write?.Condition).toEqual({
      "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEPT#*#CAD_INGRESS"] },
    });
    const rule = resourcesOfType("aws:cloudwatch/eventRule:EventRule").find(
      (r) => r.inputs.name === "boxalarm-dev-alerting-cad-source-copy",
    );
    expect(JSON.parse(rule?.inputs.eventPattern as string)).toEqual({
      source: ["platform-service"],
      "detail-type": ["platform.config.updated"],
      detail: { payload: { configType: ["CAD_INGRESS"] } },
    });
  });
});

describe("CadIngress update notifier (CAD updates to a paged call)", { timeout: 30_000 }, () => {
  it("is async-invoked by the ingress Lambdas, never a third table-stream reader", async () => {
    await build("ingress.nichols.example.org");
    for (const fn of [WEBHOOK_FN, EMAIL_FN]) {
      expect(
        isGranted(statementsForRole(fn), "lambda:InvokeFunction", (r) => r.endsWith(NOTIFIER_FN)),
      ).toBe(true);
      expect(lambdaEnv(fn).CAD_UPDATE_NOTIFIER_FUNCTION).toBe(NOTIFIER_FN);
      if (fn === WEBHOOK_FN) {
        expect(lambdaEnv(fn).CAD_WEBHOOK_SECRET_PREFIX).toBe("boxalarm-dev-cad-webhook/");
      }
    }
    expect(
      resourcesOfType("aws:lambda/eventSourceMapping:EventSourceMapping").some(
        (m) => m.inputs.functionName === NOTIFIER_FN,
      ),
    ).toBe(false);
    const invoke = resourcesOfType(
      "aws:lambda/functionEventInvokeConfig:FunctionEventInvokeConfig",
    ).find((r) => r.inputs.functionName === NOTIFIER_FN);
    expect(invoke?.inputs).toMatchObject({ maximumRetryAttempts: 2 });
  });

  it("a 5-minute sweep re-drives pending updates: reads only the pending partition, invokes only the notifier", async () => {
    await build();
    const schedule = resourcesOfType("aws:scheduler/schedule:Schedule").find(
      (r) => r.inputs.name === "boxalarm-dev-alerting-nichols-fd-cad-update-sweep",
    );
    expect(schedule?.inputs.scheduleExpression).toBe("rate(5 minutes)");
    const statements = statementsForRole(SWEEP_FN);
    expect(statements.find((st) => st.Sid === "CadUpdatePendingRead")?.Condition).toEqual({
      "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEPT#*#CAD_UPDATE_PENDING"] },
    });
    expect(isGranted(statements, "lambda:InvokeFunction", (r) => r.endsWith(NOTIFIER_FN))).toBe(
      true,
    );
    expect(lambdaEnv(SWEEP_FN).CAD_SWEEP_DEPT_ID).toBe("nichols-fd");
  });

  it("publishes only to the alerting topic and touches only dispatch partitions", async () => {
    await build();
    const statements = statementsForRole(NOTIFIER_FN);
    expect(isGranted(statements, "sns:Publish", TOPIC_ARN)).toBe(true);
    const table = statements.find((s) => s.Sid === "CadUpdateNotifierDispatchPartition");
    expect(table?.Condition).toEqual({
      "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEPT#*#DISPATCH#*"] },
    });
    // It may delete only pending-update markers.
    const del = statements.filter((st) => [st.Action].flat().includes("dynamodb:DeleteItem"));
    expect(del.map((st) => st.Condition)).toEqual([
      { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEPT#*#CAD_UPDATE_PENDING"] } },
    ]);
  });
});

describe(
  "CadIngress webhook: own REST API, per-source API keys, no Cognito (security review M4)",
  { timeout: 30_000 },
  () => {
    it("is its own REST API whose one method needs an API key and has no authorizer", async () => {
      await build();
      expect(resourcesOfType("aws:apigateway/restApi:RestApi").map((a) => a.inputs.name)).toEqual([
        "boxalarm-dev-cad-ingress-api",
      ]);
      expect(resourcesOfType("aws:apigatewayv2/api:Api")).toEqual([]);
      expect(resourcesOfType("aws:apigateway/authorizer:Authorizer")).toEqual([]);
      const methods = resourcesOfType("aws:apigateway/method:Method");
      expect(methods).toHaveLength(1);
      expect(methods[0]?.inputs).toMatchObject({
        httpMethod: "POST",
        authorization: "NONE",
        apiKeyRequired: true,
      });
      expect(
        resourcesOfType("aws:apigateway/resource:Resource").map((r) => r.inputs.pathPart),
      ).toEqual(CAD_WEBHOOK_PATH.split("/"));
    });

    it("partitions capacity per key in a usage plan, with NO shared stage-wide throttle", async () => {
      await build();
      const plan = resourcesOfType("aws:apigateway/usagePlan:UsagePlan")[0];
      expect(plan?.inputs.throttleSettings).toMatchObject({
        rateLimit: CAD_WEBHOOK_KEY_THROTTLE.rateLimit,
        burstLimit: CAD_WEBHOOK_KEY_THROTTLE.burstLimit,
      });
      const settings = resourcesOfType("aws:apigateway/methodSettings:MethodSettings")[0];
      expect(settings?.inputs.settings).toEqual({ metricsEnabled: true });
      expect(lambdaByName(WEBHOOK_FN).inputs.reservedConcurrentExecutions).toBe(5);
      expect(lambdaByName(WEBHOOK_FN).inputs.timeout).toBe(10);
    });

    it("enforces an optional source-IP allowlist in the resource policy", async () => {
      await build(undefined, ["203.0.113.0/28"]);
      const policy = JSON.parse(
        resourcesOfType("aws:apigateway/restApi:RestApi")[0]?.inputs.policy as string,
      ) as { Statement: { Effect: string; Condition?: unknown }[] };
      expect(policy.Statement.find((st) => st.Effect === "Deny")?.Condition).toEqual({
        NotIpAddress: { "aws:SourceIp": ["203.0.113.0/28"] },
      });
    });

    it("has no Deny statement without an allowlist", async () => {
      await build();
      const policy = JSON.parse(
        resourcesOfType("aws:apigateway/restApi:RestApi")[0]?.inputs.policy as string,
      ) as { Statement: { Effect: string }[] };
      expect(policy.Statement.every((st) => st.Effect === "Allow")).toBe(true);
    });

    it("creates no email resources without a mail domain", async () => {
      await build();
      expect(resourcesOfType("aws:ses/receiptRule:ReceiptRule")).toEqual([]);
      expect(() => lambdaByName(EMAIL_FN)).toThrow();
    });
  },
);

describe("CadIngress email: SES -> encrypted bucket -> Lambda", { timeout: 30_000 }, () => {
  it("stores mail with SSE-KMS, private, expiring, SES-only writes", async () => {
    await build("Ingress.Nichols.example.org");
    const sse = resourcesOfType(
      "aws:s3/bucketServerSideEncryptionConfigurationV2:BucketServerSideEncryptionConfigurationV2",
    )[0];
    expect(sse?.inputs.rules).toEqual([
      expect.objectContaining({
        applyServerSideEncryptionByDefault: expect.objectContaining({ sseAlgorithm: "aws:kms" }),
        bucketKeyEnabled: true,
      }),
    ]);
    const pab = resourcesOfType("aws:s3/bucketPublicAccessBlock:BucketPublicAccessBlock")[0];
    expect(pab?.inputs).toMatchObject({ blockPublicAcls: true, restrictPublicBuckets: true });
    const policy = JSON.parse(
      resourcesOfType("aws:s3/bucketPolicy:BucketPolicy")[0]?.inputs.policy as string,
    ) as { Statement: { Sid: string; Condition?: unknown; Resource: unknown }[] };
    const sesWrite = policy.Statement.find((s) => s.Sid === "SesWritesInboundMailOnly");
    expect(sesWrite?.Condition).toMatchObject({
      StringEquals: { "aws:SourceAccount": ACCOUNT_ID },
    });
    expect(policy.Statement.some((s) => s.Sid === "DenyInsecureTransport")).toBe(true);
  });

  it("stores then invokes the Lambda asynchronously, with scanning and TLS required", async () => {
    await build("ingress.nichols.example.org");
    const rule = resourcesOfType("aws:ses/receiptRule:ReceiptRule")[0];
    expect(rule?.inputs).toMatchObject({
      recipients: ["ingress.nichols.example.org"],
      scanEnabled: true,
      tlsPolicy: "Require",
      s3Actions: [expect.objectContaining({ objectKeyPrefix: "inbound/", position: 1 })],
      lambdaActions: [expect.objectContaining({ invocationType: "Event", position: 2 })],
    });
    expect(resourcesOfType("aws:ses/activeReceiptRuleSet:ActiveReceiptRuleSet")).toHaveLength(1);
    expect(lambdaEnv(EMAIL_FN)).toMatchObject({
      CAD_MAIL_PREFIX: "inbound/",
      CAD_INGRESS_EMAIL_DOMAIN: "ingress.nichols.example.org",
    });
    const statements = statementsForRole(EMAIL_FN);
    expect(isGranted(statements, "s3:GetObject", (r) => r.endsWith("/inbound/*"))).toBe(true);
    expect(isGranted(statements, "s3:PutObject", () => true)).toBe(false);
    const permission = resourcesOfType("aws:lambda/permission:Permission").find(
      (p) => p.inputs.principal === "ses.amazonaws.com",
    );
    expect(permission?.inputs.sourceAccount).toBe(ACCOUNT_ID);
  });

  it("sends an email that failed after retries to an alarmed failure queue", async () => {
    await build("ingress.nichols.example.org");
    const invoke = resourcesOfType(
      "aws:lambda/functionEventInvokeConfig:FunctionEventInvokeConfig",
    ).find((r) => r.inputs.functionName === "boxalarm-dev-alerting-cad-email");
    expect(invoke?.inputs).toMatchObject({
      maximumRetryAttempts: 2,
      maximumEventAgeInSeconds: 600,
    });
    expect(
      alarmByName("boxalarm-dev-alerting-cad-email-failures-not-empty").inputs.alarmActions,
    ).toEqual([PAGE]);
  });
});

describe(
  "CadIngress alarms go to the ops page topic, never the crew FIFO",
  { timeout: 30_000 },
  () => {
    it.each([
      ["boxalarm-dev-alerting-cad-auth-failed", [PAGE, OPS]],
      ["boxalarm-dev-alerting-cad-replay-rejected", [PAGE]],
      ["boxalarm-dev-alerting-cad-quarantined", [PAGE, OPS]],
      ["boxalarm-dev-alerting-cad-rejected", [PAGE]],
      ["boxalarm-dev-alerting-cad-duplicate", [PAGE]],
      ["boxalarm-dev-alerting-cad-source-dropped", [PAGE, OPS]],
      ["boxalarm-dev-alerting-cad-update-push-failed", [PAGE]],
      ["boxalarm-dev-alerting-cad-update-unnotified", [PAGE]],
      ["boxalarm-dev-alerting-cad-update-sweep-errors", [PAGE]],
      ["boxalarm-dev-alerting-cad-update-notifier-failures-not-empty", [PAGE]],
      ["boxalarm-dev-alerting-cad-raw-fallback", [PAGE, OPS]],
      ["boxalarm-dev-alerting-cad-webhook-4xx", [PAGE, OPS]],
      ["boxalarm-dev-alerting-cad-webhook-errors", [PAGE]],
      ["boxalarm-dev-alerting-cad-webhook-throttles", [PAGE]],
      ["boxalarm-dev-alerting-cad-source-copy-dlq-not-empty", [PAGE]],
    ])("%s", async (name, actions) => {
      await build("ingress.nichols.example.org");
      expect(alarmByName(name).inputs.alarmActions).toEqual(actions);
    });

    it("no alarm or resource publishes to the crew delivery topic", async () => {
      await build("ingress.nichols.example.org");
      for (const alarm of resourcesOfType("aws:cloudwatch/metricAlarm:MetricAlarm")) {
        expect(alarm.inputs.alarmActions).not.toContain(CREW_FIFO);
      }
    });

    it("the auth-failed alarm fires on a small burst (3 in 5 minutes), the others on any", async () => {
      await build();
      expect(alarmByName("boxalarm-dev-alerting-cad-auth-failed").inputs).toMatchObject({
        namespace: "Boxalarm/alerting-cad-ingress",
        metricName: "CadIngressAuthFailed",
        threshold: 2,
        period: 300,
        comparisonOperator: "GreaterThanThreshold",
      });
      expect(alarmByName("boxalarm-dev-alerting-cad-replay-rejected").inputs.threshold).toBe(0);
    });
  },
);
