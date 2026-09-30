import { beforeEach, describe, expect, it } from "vitest";
import type { HttpApi } from "../../components/api/http-api";
import { CadSources } from "../../components/platform/cad-sources";
import { ServiceLogGroup } from "../../components/observability/service-log-group";
import {
  ACCOUNT_ID,
  installMocks,
  isGranted,
  lambdaEnv,
  settle,
  statementsForRole,
} from "../alerting/mock-harness";

const PLATFORM_TABLE = "arn:aws:dynamodb:us-east-1:123456789012:table/boxalarm-dev-platform-table";
const SETTINGS_FN = "boxalarm-dev-platform-cad-sources";
const ROTATE_FN = "boxalarm-dev-platform-cad-sources-rotate-key";
const SECRETS = `arn:aws:secretsmanager:us-east-1:${ACCOUNT_ID}:secret:boxalarm-dev-cad-webhook/*`;

const routes: { routeKey: string; lambda: string }[] = [];

beforeEach(() => {
  installMocks();
  routes.length = 0;
});

async function build(): Promise<void> {
  const httpApi = {
    route: (_name: string, args: { routeKey: string; lambda: { function: { name: unknown } } }) => {
      (args.lambda.function.name as { apply: (fn: (n: string) => void) => void }).apply((n) =>
        routes.push({ routeKey: args.routeKey, lambda: n }),
      );
      return {};
    },
  } as unknown as HttpApi;
  new CadSources("cad-sources", {
    env: "dev",
    platformTableName: "boxalarm-dev-platform-table",
    platformTableArn: PLATFORM_TABLE,
    policyStoreArn: "arn:aws:verifiedpermissions::123456789012:policy-store/ps-1",
    policyStoreId: "ps-1",
    logGroup: new ServiceLogGroup("platform-lg", { env: "dev", serviceName: "platform-service" }),
    httpApi,
    webhookUrl: "https://cad.example.org/api/v1/alerting/ingress/cad-webhook",
    emailDomain: "Ingress.Nichols.example.org",
  });
  await settle();
  await settle();
}

describe("CadSources (platform settings routes)", { timeout: 30_000 }, () => {
  it("registers the four Cognito-authorized routes on the right Lambdas", async () => {
    await build();
    expect(routes).toHaveLength(5);
    expect(routes).toEqual(
      expect.arrayContaining([
        { routeKey: "GET /api/v1/platform/cad-sources", lambda: SETTINGS_FN },
        { routeKey: "POST /api/v1/platform/cad-sources/test-parse", lambda: SETTINGS_FN },
        { routeKey: "POST /api/v1/platform/cad-sources/{sourceId}/webhook-key", lambda: ROTATE_FN },
        { routeKey: "PUT /api/v1/platform/cad-sources", lambda: SETTINGS_FN },
        {
          routeKey: "POST /api/v1/platform/cad-sources/{sourceId}/webhook-key/revoke-previous",
          lambda: ROTATE_FN,
        },
      ]),
    );
  });

  it("only the rotation Lambda can read or write the CAD webhook secrets; settings may only delete", async () => {
    await build();
    const settings = statementsForRole(SETTINGS_FN);
    expect(
      settings.flatMap((s) => [s.Action].flat()).filter((a) => a.startsWith("secretsmanager:")),
    ).toEqual(["secretsmanager:DeleteSecret"]);
    expect(isGranted(settings, "secretsmanager:DeleteSecret", SECRETS)).toBe(true);
    const rotate = statementsForRole(ROTATE_FN);
    for (const action of [
      "secretsmanager:CreateSecret",
      "secretsmanager:PutSecretValue",
      "secretsmanager:GetSecretValue",
    ]) {
      expect(isGranted(rotate, action, SECRETS)).toBe(true);
      expect(isGranted(rotate, action, "*")).toBe(false);
    }
    expect(lambdaEnv(ROTATE_FN).CAD_WEBHOOK_SECRET_PREFIX).toBe("boxalarm-dev-cad-webhook/");
  });

  it("scopes the table to the department partition and its outbox", async () => {
    await build();
    for (const fn of [SETTINGS_FN, ROTATE_FN]) {
      const config = statementsForRole(fn).find((s) => s.Sid === "CadSourcesConfig");
      expect(config?.Condition).toEqual({
        "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEPT#*"] },
        "ForAllValues:StringNotLike": { "dynamodb:LeadingKeys": ["DEPT#*#*"] },
      });
      const outbox = statementsForRole(fn).find((s) => s.Sid === "CadSourcesOutbox");
      expect(outbox?.Condition).toEqual({
        "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEPT#*#OUTBOX"] },
      });
    }
    expect(lambdaEnv(SETTINGS_FN)).toMatchObject({
      CAD_INGRESS_EMAIL_DOMAIN: "ingress.nichols.example.org",
      CAD_WEBHOOK_URL: "https://cad.example.org/api/v1/alerting/ingress/cad-webhook",
    });
  });
});
