import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { HttpApi } from "../api/http-api";
import { verifiedPermissionsPolicyStatement } from "../authz/policy-store";
import { IamPolicyStatement } from "../observability/observability-policy";
import { auditMutationDenyStatement } from "../data/platform-table";
import { cadWebhookSecretPrefix } from "../alerting/cad-ingress";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { requireEnv } from "../shared/env";

export interface CadSourcesArgs {
  env: string;
  platformTableName: pulumi.Input<string>;
  platformTableArn: pulumi.Input<string>;
  policyStoreArn: pulumi.Input<string>;
  policyStoreId: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
  httpApi: HttpApi;
  /** Shown to the chief as the webhook address. */
  webhookUrl: pulumi.Input<string>;
  /** The webhook's usage plan: each source's API key is attached to it on rotation. */
  webhookUsagePlanId: pulumi.Input<string>;
  /** The inbound mail domain, when the email path exists. */
  emailDomain?: string;
}

/**
 * The CAD sources settings routes (platform-service cadSources/): the department's CAD
 * ingress config is authored here by CHIEF/ADMIN (Cedar View/ManageCadIngress) and reaches the
 * alerting plane only through platform.config.updated -> CAD_INGRESS_COPY (cad-ingress.ts).
 *
 * Least privilege, the NERIS-entity pattern: both Lambdas touch only the department's own
 * partition (`DEPT#{deptId}`, the CONFIG#CAD_INGRESS row) and its outbox. Only the rotation
 * Lambda can read or write the CAD webhook secrets, and only those (name prefix); the settings
 * Lambda may only DELETE them (a removed source's secret goes with it).
 */
function deptPartitionStatement(sid: string, actions: string[], tableArn: string) {
  return {
    Sid: sid,
    Effect: "Allow" as const,
    Action: actions,
    Resource: tableArn,
    Condition: {
      "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEPT#*"] },
      "ForAllValues:StringNotLike": { "dynamodb:LeadingKeys": ["DEPT#*#*"] },
    },
  };
}

function outboxStatement(tableArn: string): IamPolicyStatement {
  return {
    Sid: "CadSourcesOutbox",
    Effect: "Allow",
    Action: ["dynamodb:PutItem"],
    Resource: tableArn,
    Condition: { "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEPT#*#OUTBOX"] } },
  };
}

/** Delete CAD webhook API keys only (tagged boxalarm:purpose=cad-webhook at creation). */
function cadApiKeyDeleteStatement(regionName: string): IamPolicyStatement {
  return {
    Sid: "CadWebhookApiKeysDelete",
    Effect: "Allow",
    Action: ["apigateway:DELETE"],
    Resource: `arn:aws:apigateway:${regionName}::/apikeys/*`,
    Condition: { StringEquals: { "aws:ResourceTag/boxalarm:purpose": ["cad-webhook"] } },
  };
}

export class CadSources extends pulumi.ComponentResource {
  public readonly settingsLambda: ServiceLambda;
  public readonly rotateKeyLambda: ServiceLambda;

  constructor(name: string, args: CadSourcesArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("CadSources", args.env);
    super("boxalarm:platform:CadSources", name, {}, opts);
    const { env } = args;
    const identity = aws.getCallerIdentityOutput({}, { parent: this });
    const region = aws.getRegionOutput({}, { parent: this });
    const secretArnPattern = pulumi.interpolate`arn:aws:secretsmanager:${region.name}:${identity.accountId}:secret:${cadWebhookSecretPrefix(env)}*`;

    const environment = {
      PLATFORM_TABLE_NAME: args.platformTableName,
      VERIFIED_PERMISSIONS_POLICY_STORE_ID: args.policyStoreId,
      CAD_WEBHOOK_URL: args.webhookUrl,
      ...(args.emailDomain !== undefined
        ? { CAD_INGRESS_EMAIL_DOMAIN: args.emailDomain.toLowerCase() }
        : {}),
    };

    this.settingsLambda = new ServiceLambda(
      `${name}-settings`,
      {
        env,
        serviceName: "platform-service",
        functionName: `boxalarm-${env}-platform-cad-sources`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("platform-service", "cad-sources"),
        logGroup: args.logGroup,
        environment: { ...environment, CAD_WEBHOOK_SECRET_PREFIX: cadWebhookSecretPrefix(env) },
        additionalPolicyStatements: pulumi
          .all([args.platformTableArn, args.policyStoreArn, secretArnPattern, region.name])
          .apply(([tableArn, policyStoreArn, secretArn, regionName]): IamPolicyStatement[] => [
            cadApiKeyDeleteStatement(regionName),
            {
              // A removed source's webhook secret is deleted with it (security review M5).
              // Delete only - this Lambda can never read a key.
              Sid: "CadWebhookSecretsDelete",
              Effect: "Allow",
              Action: ["secretsmanager:DeleteSecret"],
              Resource: secretArn,
            },
            // GetItem the CONFIG#CAD_INGRESS row; its save is two Puts in one transaction.
            deptPartitionStatement(
              "CadSourcesConfig",
              ["dynamodb:GetItem", "dynamodb:PutItem"],
              tableArn,
            ),
            outboxStatement(tableArn),
            auditMutationDenyStatement(tableArn),
            verifiedPermissionsPolicyStatement(policyStoreArn),
          ]),
      },
      { parent: this },
    );

    this.rotateKeyLambda = new ServiceLambda(
      `${name}-rotate-key`,
      {
        env,
        serviceName: "platform-service",
        functionName: `boxalarm-${env}-platform-cad-sources-rotate-key`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("platform-service", "cad-sources-rotate-key"),
        logGroup: args.logGroup,
        environment: {
          ...environment,
          CAD_WEBHOOK_SECRET_PREFIX: cadWebhookSecretPrefix(env),
          CAD_WEBHOOK_USAGE_PLAN_ID: args.webhookUsagePlanId,
        },
        additionalPolicyStatements: pulumi
          .all([
            args.platformTableArn,
            args.policyStoreArn,
            secretArnPattern,
            region.name,
            args.webhookUsagePlanId,
          ])
          .apply(
            ([tableArn, policyStoreArn, secretArn, regionName, planId]): IamPolicyStatement[] => [
              {
                // Each source's API key (its own throttle bucket, security review M4): created
                // tagged, attached to the webhook usage plan, and the replaced one deleted.
                Sid: "CadWebhookApiKeysCreate",
                Effect: "Allow",
                Action: ["apigateway:POST"],
                Resource: [
                  `arn:aws:apigateway:${regionName}::/apikeys`,
                  `arn:aws:apigateway:${regionName}::/usageplans/${planId}/keys`,
                  `arn:aws:apigateway:${regionName}::/tags/*`,
                ],
              },
              cadApiKeyDeleteStatement(regionName),
              deptPartitionStatement(
                "CadSourcesConfig",
                ["dynamodb:GetItem", "dynamodb:PutItem"],
                tableArn,
              ),
              outboxStatement(tableArn),
              auditMutationDenyStatement(tableArn),
              verifiedPermissionsPolicyStatement(policyStoreArn),
              {
                // Reads the old key (it becomes `previous`), writes the new one; creates the
                // secret on first rotation. The CAD webhook secrets only.
                Sid: "CadWebhookKeysRotate",
                Effect: "Allow",
                Action: [
                  "secretsmanager:CreateSecret",
                  "secretsmanager:PutSecretValue",
                  "secretsmanager:GetSecretValue",
                ],
                Resource: secretArn,
              },
            ],
          ),
        timeout: 10,
      },
      { parent: this },
    );

    for (const [suffix, routeKey, lambda] of [
      ["get", "GET /api/v1/platform/cad-sources", this.settingsLambda],
      ["put", "PUT /api/v1/platform/cad-sources", this.settingsLambda],
      ["test-parse", "POST /api/v1/platform/cad-sources/test-parse", this.settingsLambda],
      [
        "new-email-address",
        "POST /api/v1/platform/cad-sources/{sourceId}/email-address",
        this.settingsLambda,
      ],
      [
        "rotate-key",
        "POST /api/v1/platform/cad-sources/{sourceId}/webhook-key",
        this.rotateKeyLambda,
      ],
      [
        "revoke-previous-key",
        "POST /api/v1/platform/cad-sources/{sourceId}/webhook-key/revoke-previous",
        this.rotateKeyLambda,
      ],
    ] as const) {
      args.httpApi.route(`${name}-${suffix}-route`, { routeKey, lambda }, { parent: this });
    }

    this.registerOutputs({
      settingsLambda: this.settingsLambda,
      rotateKeyLambda: this.rotateKeyLambda,
    });
  }
}
