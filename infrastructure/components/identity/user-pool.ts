import * as path from "path";
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { RETENTION_DAYS_BY_ENV } from "../observability/service-log-group";

export interface BoxalarmUserPoolArgs {
  env: string;
}

// #180: the shared Lambda authorizer in boxalarm-backend reads deptId
// only from the verified ACCESS token — never a header, body, or the ID token — so
// this is the sole producer of that value. Every field here exists to satisfy one of
// #115's acceptance criteria; see the inline notes below for which.
export class BoxalarmUserPool extends pulumi.ComponentResource {
  public readonly userPool: aws.cognito.UserPool;
  public readonly userPoolDomain: aws.cognito.UserPoolDomain;
  /** Cognito prefix domain, e.g. boxalarm-dev (not a custom domain). */
  public readonly domainName: string;
  public readonly preTokenGenerationFunction: aws.lambda.Function;
  public readonly functionRole: aws.iam.Role;
  public readonly functionLogGroup: aws.cloudwatch.LogGroup;
  public readonly invokePermission: aws.lambda.Permission;

  constructor(name: string, args: BoxalarmUserPoolArgs, opts?: pulumi.ComponentResourceOptions) {
    if (typeof args.env !== "string" || args.env.length === 0) {
      throw new Error(`BoxalarmUserPool: env is required (received ${JSON.stringify(args.env)})`);
    }
    const retentionInDays = RETENTION_DAYS_BY_ENV[args.env];
    if (retentionInDays === undefined) {
      throw new Error(`BoxalarmUserPool: unknown env "${args.env}" — no retention configured`);
    }

    super("boxalarm:identity:UserPool", name, {}, opts);
    const { env } = args;

    this.functionLogGroup = new aws.cloudwatch.LogGroup(
      `${name}-fn-log-group`,
      {
        name: `/aws/lambda/boxalarm-${env}-identity-pre-token-generation`,
        retentionInDays,
      },
      { parent: this },
    );

    this.functionRole = new aws.iam.Role(
      `${name}-fn-role`,
      {
        name: `boxalarm-${env}-identity-pre-token-generation`,
        assumeRolePolicy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "lambda.amazonaws.com" },
              Action: "sts:AssumeRole",
            },
          ],
        }),
      },
      { parent: this },
    );

    new aws.iam.RolePolicy(
      `${name}-fn-role-policy`,
      {
        role: this.functionRole.id,
        policy: this.functionLogGroup.arn.apply((logGroupArn) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: "WriteOwnLogGroup",
                Effect: "Allow",
                Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
                Resource: `${logGroupArn}:*`,
              },
            ],
          }),
        ),
      },
      { parent: this },
    );

    // Given acceptance criterion 2 (custom:deptId must be structurally impossible to
    // omit) is enforced entirely inside the trigger function, this component has
    // exactly one Lambda source instead of leaving each call site to remember it.
    this.preTokenGenerationFunction = new aws.lambda.Function(
      `${name}-fn`,
      {
        name: `boxalarm-${env}-identity-pre-token-generation`,
        runtime: aws.lambda.Runtime.NodeJS20dX,
        handler: "pre-token-generation-handler.handler",
        role: this.functionRole.arn,
        code: new pulumi.asset.AssetArchive({
          "pre-token-generation-handler.js": new pulumi.asset.FileAsset(
            path.join(__dirname, "pre-token-generation-handler.js"),
          ),
        }),
        loggingConfig: {
          logFormat: "Text",
          logGroup: this.functionLogGroup.name,
        },
      },
      { parent: this, dependsOn: [this.functionLogGroup] },
    );

    this.userPool = new aws.cognito.UserPool(
      `${name}-pool`,
      {
        name: `boxalarm-${env}-users`,
        // Explicit OFF until MFA is productized — do not rely on Cognito's default.
        mfaConfiguration: "OFF",
        // AC1: dev-vs-prod separation lives at the environment/stack level (one pool
        // per env, this component instantiated once per Pulumi.<env>.yaml stack).
        schemas: [
          {
            name: "deptId",
            attributeDataType: "String",
            // Mutable, not immutable: an admin must be able to correct a
            // mis-provisioned department (AdminUpdateUserAttributes). Self-service
            // write access is blocked separately, at the app-client level — see
            // write-attributes.ts — not by making the schema itself immutable.
            mutable: true,
            // Cognito rejects required: true for any custom attribute.
            required: false,
            stringAttributeConstraints: { minLength: "1", maxLength: "64" },
          },
        ],
        lambdaConfig: {
          // V2_0, not the legacy `preTokenGeneration` ARN-only field: only V2 supports
          // overriding ACCESS token claims (claimsAndScopeOverrideDetails.
          // accessTokenGeneration). The V1 shape can only add claims to the ID token,
          // which is exactly the mistake #115 warns is easy to make silently.
          preTokenGenerationConfig: {
            lambdaArn: this.preTokenGenerationFunction.arn,
            lambdaVersion: "V2_0",
          },
        },
      },
      { parent: this },
    );

    this.domainName = `boxalarm-${env}`;
    this.userPoolDomain = new aws.cognito.UserPoolDomain(
      `${name}-domain`,
      {
        domain: this.domainName,
        userPoolId: this.userPool.id,
      },
      { parent: this },
    );

    this.invokePermission = new aws.lambda.Permission(
      `${name}-fn-invoke-permission`,
      {
        action: "lambda:InvokeFunction",
        function: this.preTokenGenerationFunction.name,
        principal: "cognito-idp.amazonaws.com",
        sourceArn: this.userPool.arn,
      },
      { parent: this },
    );

    this.registerOutputs({
      userPool: this.userPool,
      userPoolDomain: this.userPoolDomain,
      domainName: this.domainName,
      preTokenGenerationFunction: this.preTokenGenerationFunction,
    });
  }
}
