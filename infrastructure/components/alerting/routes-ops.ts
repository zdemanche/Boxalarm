import * as pulumi from "@pulumi/pulumi";
import { HttpApi } from "../api/http-api";
import { ServiceLogGroup } from "../observability/service-log-group";
import { IamPolicyStatement } from "../observability/observability-policy";
import { requireEnv } from "../shared/env";
import { httpStubCode } from "./stub-code";
import { AlertingRoute } from "./route-lambda";
import { policyStore } from "../authz/policy-store";

export interface RoutesOpsArgs {
  env: string;
  httpApi: HttpApi;
  alertingTableArn: pulumi.Input<string>;
  alertingTableName: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  permissionsBoundaryArn?: pulumi.Input<string>;
}

type VendorChannel = "sms" | "voice" | "push";
const VENDOR_CHANNELS: readonly VendorChannel[] = ["sms", "voice", "push"];

/**
 * Self-test, audit, and provider delivery-receipt routes (E1-S4/S8/S9/S14-INFRA-partial).
 * Vendor webhook routes carry no Cognito/Verified-Permissions authorizer — the handler
 * verifies a per-vendor shared secret itself — and each vendor Lambda can read only its
 * own webhook secret.
 */
export class RoutesOps extends pulumi.ComponentResource {
  public readonly selfTestPost: AlertingRoute;
  public readonly selfTestGet: AlertingRoute;
  public readonly audit: AlertingRoute;
  public readonly receiptsGet: AlertingRoute;
  public readonly webhooks: Record<VendorChannel, AlertingRoute>;

  constructor(name: string, args: RoutesOpsArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("RoutesOps", args.env);
    super("boxalarm:alerting:RoutesOps", name, {}, opts);
    const { env } = args;

    const verifiedPermissionsStatement: IamPolicyStatement = {
      Sid: "VerifiedPermissionsIsAuthorized",
      Effect: "Allow",
      Action: ["verifiedpermissions:IsAuthorizedWithToken"],
      Resource: "*",
    };

    // src/services/alerting-service/selfTest/postHandler.handler
    this.selfTestPost = new AlertingRoute(
      `${name}-self-test-post`,
      {
        env,
        httpApi: args.httpApi,
        logGroup: args.logGroup,
        serviceName: "alerting-service",
        functionName: `boxalarm-${env}-alerting-self-test-post`,
        handler: "index.handler",
        code: httpStubCode(),
        routeKey: "POST /api/v1/alerting/self-test",
        environment: {
          ALERTING_TABLE_NAME: args.alertingTableName,
          VERIFIED_PERMISSIONS_POLICY_STORE_ID: policyStore.policyStoreId,
        },
        additionalPolicyStatements: [
          {
            Sid: "AlertingTableSelfTestWrite",
            Effect: "Allow",
            Action: ["dynamodb:PutItem", "dynamodb:TransactWriteItems", "dynamodb:Query"],
            Resource: args.alertingTableArn as string,
          },
          verifiedPermissionsStatement,
        ],
        reservedConcurrentExecutions: 3,
        permissionsBoundaryArn: args.permissionsBoundaryArn,
      },
      { parent: this },
    );

    // src/services/alerting-service/selfTest/getHandler.handler
    this.selfTestGet = new AlertingRoute(
      `${name}-self-test-get`,
      {
        env,
        httpApi: args.httpApi,
        logGroup: args.logGroup,
        serviceName: "alerting-service",
        functionName: `boxalarm-${env}-alerting-self-test-get`,
        handler: "index.handler",
        code: httpStubCode(),
        routeKey: "GET /api/v1/alerting/self-test/{testId}",
        environment: {
          ALERTING_TABLE_NAME: args.alertingTableName,
          VERIFIED_PERMISSIONS_POLICY_STORE_ID: policyStore.policyStoreId,
        },
        additionalPolicyStatements: [
          {
            Sid: "AlertingTableSelfTestRead",
            Effect: "Allow",
            Action: ["dynamodb:Query", "dynamodb:GetItem"],
            Resource: args.alertingTableArn as string,
          },
          verifiedPermissionsStatement,
        ],
        reservedConcurrentExecutions: 3,
        permissionsBoundaryArn: args.permissionsBoundaryArn,
      },
      { parent: this },
    );

    // src/services/alerting-service/audit/handler.handler
    this.audit = new AlertingRoute(
      `${name}-audit`,
      {
        env,
        httpApi: args.httpApi,
        logGroup: args.logGroup,
        serviceName: "alerting-service",
        functionName: `boxalarm-${env}-alerting-audit`,
        handler: "index.handler",
        code: httpStubCode(),
        routeKey: "GET /api/v1/alerting/audit",
        environment: {
          ALERTING_TABLE_NAME: args.alertingTableName,
          VERIFIED_PERMISSIONS_POLICY_STORE_ID: policyStore.policyStoreId,
        },
        additionalPolicyStatements: pulumi.output(args.alertingTableArn).apply((tableArn) => [
          {
            Sid: "AlertingTableAndIndexQueryOnly",
            Effect: "Allow" as const,
            Action: ["dynamodb:Query"],
            Resource: [tableArn, `${tableArn}/index/GSI1`, `${tableArn}/index/GSI2`],
          },
          verifiedPermissionsStatement,
        ]),
        reservedConcurrentExecutions: 3,
        permissionsBoundaryArn: args.permissionsBoundaryArn,
      },
      { parent: this },
    );

    // src/services/alerting-service/receipts/getDeliveryReceiptsHandler.handler
    this.receiptsGet = new AlertingRoute(
      `${name}-receipts-get`,
      {
        env,
        httpApi: args.httpApi,
        logGroup: args.logGroup,
        serviceName: "alerting-service",
        functionName: `boxalarm-${env}-alerting-receipts-get`,
        handler: "index.handler",
        code: httpStubCode(),
        routeKey: "GET /api/v1/alerting/dispatches/{dispatchId}/receipts",
        environment: {
          ALERTING_TABLE_NAME: args.alertingTableName,
          VERIFIED_PERMISSIONS_POLICY_STORE_ID: policyStore.policyStoreId,
        },
        additionalPolicyStatements: [
          {
            Sid: "AlertingTableQuery",
            Effect: "Allow",
            Action: ["dynamodb:Query"],
            Resource: args.alertingTableArn as string,
          },
          verifiedPermissionsStatement,
        ],
        reservedConcurrentExecutions: 3,
        permissionsBoundaryArn: args.permissionsBoundaryArn,
      },
      { parent: this },
    );

    const webhookRouteKeys: Record<VendorChannel, string> = {
      sms: "POST /api/v1/alerting/receipts/sms",
      voice: "POST /api/v1/alerting/receipts/voice",
      push: "POST /api/v1/alerting/receipts/push",
    };
    const webhookSecretEnvVar: Record<VendorChannel, string> = {
      sms: "SMS_PROVIDER_WEBHOOK_SECRET",
      voice: "VOICE_PROVIDER_WEBHOOK_SECRET",
      push: "PUSH_PROVIDER_WEBHOOK_SECRET",
    };
    // Real handlers:
    //  src/services/alerting-service/receipts/smsDeliveryReceiptHandler.handler
    //  src/services/alerting-service/receipts/voiceDeliveryReceiptHandler.handler
    //  src/services/alerting-service/receipts/pushReceiptHandler.handler
    //
    // These handlers compare the caller-supplied header directly against the raw
    // secretEnvVar value (no Secrets Manager lookup at send time) — see
    // receipts/vendorAuth.ts / deliveryReceiptWebhookHandler.ts — so each vendor secret
    // is a Pulumi stack secret (`pulumi config set --secret`, values set out-of-band
    // like NerisConfig's credentials), never an AWS Secrets Manager resource whose ARN
    // this Lambda would need read IAM for. Isolation (E1-S11-INFRA) is by construction:
    // each webhook Lambda's environment carries only its own channel's config key.
    const config = new pulumi.Config("boxalarm-infra");
    const webhooks: Partial<Record<VendorChannel, AlertingRoute>> = {};

    for (const channel of VENDOR_CHANNELS) {
      webhooks[channel] = new AlertingRoute(
        `${name}-${channel}-webhook`,
        {
          env,
          httpApi: args.httpApi,
          logGroup: args.logGroup,
          serviceName: "alerting-service",
          functionName: `boxalarm-${env}-alerting-${channel}-receipt-webhook`,
          handler: "index.handler",
          code: httpStubCode(),
          routeKey: webhookRouteKeys[channel],
          authorized: false,
          environment: {
            ALERTING_TABLE_NAME: args.alertingTableName,
            [webhookSecretEnvVar[channel]]: config.requireSecret(`${channel}WebhookSecret`),
          },
          additionalPolicyStatements: [
            {
              Sid: "AlertingTableReceiptWrite",
              Effect: "Allow",
              Action: ["dynamodb:GetItem", "dynamodb:UpdateItem"],
              Resource: args.alertingTableArn as string,
            },
          ],
          reservedConcurrentExecutions: 5,
          permissionsBoundaryArn: args.permissionsBoundaryArn,
        },
        { parent: this },
      );
    }
    this.webhooks = webhooks as Record<VendorChannel, AlertingRoute>;

    this.registerOutputs({
      selfTestPost: this.selfTestPost,
      selfTestGet: this.selfTestGet,
      audit: this.audit,
      receiptsGet: this.receiptsGet,
      webhooks: this.webhooks,
    });
  }
}
