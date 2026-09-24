import * as path from "path";
import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { RETENTION_DAYS_BY_ENV } from "../observability/service-log-group";
import { ACTIVE_TRACING_CONFIG } from "../observability/xray-sampling";

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
  public readonly smsRole: aws.iam.Role;

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
        runtime: aws.lambda.Runtime.NodeJS22dX,
        handler: "pre-token-generation-handler.handler",
        role: this.functionRole.arn,
        code: new pulumi.asset.AssetArchive({
          "pre-token-generation-handler.js": new pulumi.asset.FileAsset(
            path.join(__dirname, "pre-token-generation-handler.js"),
          ),
        }),
        // Highest-availability-criticality Lambda in this component — if it fails,
        // Cognito fails token generation and every sign-in fails. It doesn't go
        // through the ServiceLambda factory (that would require an identity-service
        // SERVICES entry, a bigger change), but at minimum matches ServiceLambda's
        // JSON logging + Active tracing convention rather than being the one
        // function in the repo with neither.
        loggingConfig: {
          logFormat: "JSON",
          logGroup: this.functionLogGroup.name,
        },
        tracingConfig: ACTIVE_TRACING_CONFIG,
      },
      { parent: this, dependsOn: [this.functionLogGroup] },
    );

    // Scoped by region/account rather than this.userPool.arn, so this permission can
    // be created independently of (and before) the pool — the pool is given a
    // dependsOn below. Referencing this.userPool.arn directly would force Pulumi to
    // create the permission only after the pool exists, leaving a window where the
    // pool has a V2 pre-token trigger it isn't yet allowed to invoke: any sign-in in
    // that window fails token generation.
    const region = aws.getRegionOutput({}, { parent: this });
    const caller = aws.getCallerIdentityOutput({}, { parent: this });
    this.invokePermission = new aws.lambda.Permission(
      `${name}-fn-invoke-permission`,
      {
        action: "lambda:InvokeFunction",
        function: this.preTokenGenerationFunction.name,
        principal: "cognito-idp.amazonaws.com",
        sourceArn: pulumi.interpolate`arn:aws:cognito-idp:${region.name}:${caller.accountId}:userpool/*`,
      },
      { parent: this },
    );

    // E8-S2-INFRA #254: confused-deputy hardening so only Cognito acting for THIS
    // account/pool can assume the role to send SMS. The external ID alone doesn't
    // hold that guarantee: it follows the same boxalarm-${env}-identity-sms pattern
    // as the role name, so it's guessable from the role name itself — any other AWS
    // account could create a user pool with snsCallerArn set to this role and that
    // external ID, and Cognito (the service principal) would assume it on their
    // behalf, sending SMS billed to Boxalarm (SMS pumping). aws:SourceAccount pins
    // the call to this account; aws:SourceArn pins it to a Cognito user pool in this
    // account/region (wildcarded on pool id to avoid a pool/role creation cycle,
    // since the pool's own ARN isn't known until after it's created below).
    this.smsRole = new aws.iam.Role(
      `${name}-sms-role`,
      {
        name: `boxalarm-${env}-identity-sms`,
        assumeRolePolicy: pulumi
          .all([region.name, caller.accountId])
          .apply(([regionName, accountId]) =>
            JSON.stringify({
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "cognito-idp.amazonaws.com" },
                  Action: "sts:AssumeRole",
                  Condition: {
                    StringEquals: {
                      "sts:ExternalId": `boxalarm-${env}-identity-sms`,
                      "aws:SourceAccount": accountId,
                    },
                    ArnLike: {
                      "aws:SourceArn": `arn:aws:cognito-idp:${regionName}:${accountId}:userpool/*`,
                    },
                  },
                },
              ],
            }),
          ),
      },
      { parent: this },
    );

    new aws.iam.RolePolicy(
      `${name}-sms-role-policy`,
      {
        role: this.smsRole.id,
        policy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            { Sid: "SendRecoverySms", Effect: "Allow", Action: "sns:Publish", Resource: "*" },
          ],
        }),
      },
      { parent: this },
    );

    this.userPool = new aws.cognito.UserPool(
      `${name}-pool`,
      {
        name: `boxalarm-${env}-users`,
        // AC1: self-service recovery via verified email first, verified phone
        // second — no human step in the path.
        accountRecoverySetting: {
          recoveryMechanisms: [
            { name: "verifiedEmail", priority: 1 },
            { name: "verifiedPhoneNumber", priority: 2 },
          ],
        },
        smsConfiguration: {
          externalId: `boxalarm-${env}-identity-sms`,
          snsCallerArn: this.smsRole.arn,
        },
        // Unlike DynamoDB, Cognito has no PITR/restore path — losing this pool means
        // every firefighter re-enrolls. ACTIVE, not the default INACTIVE.
        deletionProtection: "ACTIVE",
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
      // Pulumi's own accidental-destroy backstop — a stray `pulumi destroy` or a
      // replace-forcing rename must not be able to take out the pool. dependsOn
      // enforces that the trigger's invoke permission exists before the pool does,
      // closing the sign-in-failure window described above.
      { parent: this, protect: true, dependsOn: [this.invokePermission] },
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

    this.registerOutputs({
      userPool: this.userPool,
      userPoolDomain: this.userPoolDomain,
      domainName: this.domainName,
      preTokenGenerationFunction: this.preTokenGenerationFunction,
    });
  }
}
