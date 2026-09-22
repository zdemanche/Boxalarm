import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";

const KNOWN_ENVS = new Set(["dev", "qa", "staging", "prod"]);

/** Default retention for Object Lock compliance mode on the audit archive. */
export const AUDIT_OBJECT_LOCK_RETENTION_DAYS = 365;
/** Transition archive objects to a cheaper storage class well before the lock elapses. */
export const AUDIT_LIFECYCLE_GLACIER_TRANSITION_DAYS = 90;
/**
 * Expire objects only after the Object Lock retention elapses, plus a buffer.
 * COMPLIANCE-mode Object Lock blocks the actual deletion until the per-object
 * retain-until-date passes regardless of this rule, so the buffer just avoids the
 * lifecycle rule and the lock racing each other at the boundary.
 */
export const AUDIT_LIFECYCLE_EXPIRATION_DAYS = AUDIT_OBJECT_LOCK_RETENTION_DAYS + 30;

export interface AuditTrailArgs {
  env: string;
  /** Alerting table ARN for CloudTrail DynamoDB data events. Parent wires after AlertingTable exists. */
  alertingTableArn: pulumi.Input<string>;
}

function requireEnv(component: string, env: string): void {
  if (typeof env !== "string" || env.length === 0) {
    throw new Error(`${component}: env is required (received ${JSON.stringify(env)})`);
  }
  if (!KNOWN_ENVS.has(env)) {
    throw new Error(`${component}: unknown env "${env}"`);
  }
}

/**
 * CloudTrail data-event trail + Object Lock (compliance) archive bucket for
 * alerting-table mutations (#84 audit portion). WriteOnly by design — reads are by
 * far the highest-volume operation on a live alert path, and this trail exists to
 * make mutations reviewable, not to audit read traffic.
 */
export class AuditTrail extends pulumi.ComponentResource {
  public readonly archiveBucket: aws.s3.Bucket;
  public readonly publicAccessBlock: aws.s3.BucketPublicAccessBlock;
  public readonly serverSideEncryption: aws.s3.BucketServerSideEncryptionConfigurationV2;
  public readonly versioning: aws.s3.BucketVersioning;
  public readonly objectLockConfiguration: aws.s3.BucketObjectLockConfiguration;
  public readonly lifecycleConfiguration: aws.s3.BucketLifecycleConfigurationV2;
  public readonly bucketPolicy: aws.s3.BucketPolicy;
  public readonly trail: aws.cloudtrail.Trail;

  constructor(name: string, args: AuditTrailArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("AuditTrail", args.env);
    super("boxalarm:data:AuditTrail", name, {}, opts);
    const { env } = args;

    const caller = aws.getCallerIdentityOutput({}, { parent: this });
    const region = aws.getRegionOutput({}, { parent: this });
    const trailName = `boxalarm-${env}-alerting-data-events`;
    const bucketName = `boxalarm-${env}-audit-archive`;

    // objectLockEnabled requires versioning; AWS enables versioning when Object Lock is on.
    this.archiveBucket = new aws.s3.Bucket(
      `${name}-archive`,
      {
        bucket: bucketName,
        objectLockEnabled: true,
        forceDestroy: false,
      },
      { parent: this },
    );

    this.publicAccessBlock = new aws.s3.BucketPublicAccessBlock(
      `${name}-public-access-block`,
      {
        bucket: this.archiveBucket.id,
        blockPublicAcls: true,
        blockPublicPolicy: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true,
      },
      { parent: this },
    );

    // S3 applies SSE-S3 by default, but every other data-layer resource in this repo
    // declares its encryption tier explicitly (and a residency test asserts on that
    // text) — this makes the posture reviewable in code rather than implicit.
    this.serverSideEncryption = new aws.s3.BucketServerSideEncryptionConfigurationV2(
      `${name}-sse`,
      {
        bucket: this.archiveBucket.id,
        rules: [
          {
            applyServerSideEncryptionByDefault: {
              sseAlgorithm: "AES256",
            },
          },
        ],
      },
      { parent: this },
    );

    this.versioning = new aws.s3.BucketVersioning(
      `${name}-versioning`,
      {
        bucket: this.archiveBucket.id,
        versioningConfiguration: { status: "Enabled" },
      },
      { parent: this },
    );

    this.objectLockConfiguration = new aws.s3.BucketObjectLockConfiguration(
      `${name}-object-lock`,
      {
        bucket: this.archiveBucket.id,
        rule: {
          defaultRetention: {
            mode: "COMPLIANCE",
            days: AUDIT_OBJECT_LOCK_RETENTION_DAYS,
          },
        },
      },
      { parent: this, dependsOn: [this.versioning] },
    );

    // Data events bill per event and land in a COMPLIANCE-mode Object Lock bucket that
    // cannot be deleted or shortened by anyone, including account root, until the lock
    // elapses. Without a lifecycle rule, this is the one resource whose cost mistake is
    // irreversible for a year — usage-based cost is a CLAUDE.md hard constraint.
    this.lifecycleConfiguration = new aws.s3.BucketLifecycleConfigurationV2(
      `${name}-lifecycle`,
      {
        bucket: this.archiveBucket.id,
        rules: [
          {
            id: "archive-and-expire",
            status: "Enabled",
            transitions: [
              {
                days: AUDIT_LIFECYCLE_GLACIER_TRANSITION_DAYS,
                storageClass: "GLACIER_IR",
              },
            ],
            expiration: {
              days: AUDIT_LIFECYCLE_EXPIRATION_DAYS,
            },
          },
        ],
      },
      { parent: this, dependsOn: [this.versioning] },
    );

    // Trail ARN is deterministic from env/account/region so the bucket policy can
    // pin aws:SourceArn / aws:SourceAccount before the Trail resource exists
    // (confused-deputy hardening for a COMPLIANCE Object Lock archive).
    this.bucketPolicy = new aws.s3.BucketPolicy(
      `${name}-trail-bucket-policy`,
      {
        bucket: this.archiveBucket.id,
        policy: pulumi
          .all([this.archiveBucket.arn, caller.accountId, region.name])
          .apply(([bucketArn, accountId, regionName]) => {
            const trailArn = `arn:aws:cloudtrail:${regionName}:${accountId}:trail/${trailName}`;
            return JSON.stringify({
              Version: "2012-10-17",
              Statement: [
                {
                  Sid: "AWSCloudTrailAclCheck",
                  Effect: "Allow",
                  Principal: { Service: "cloudtrail.amazonaws.com" },
                  Action: "s3:GetBucketAcl",
                  Resource: bucketArn,
                  Condition: {
                    StringEquals: { "aws:SourceAccount": accountId },
                    ArnLike: { "aws:SourceArn": trailArn },
                  },
                },
                {
                  Sid: "AWSCloudTrailWrite",
                  Effect: "Allow",
                  Principal: { Service: "cloudtrail.amazonaws.com" },
                  Action: "s3:PutObject",
                  Resource: `${bucketArn}/AWSLogs/${accountId}/*`,
                  Condition: {
                    StringEquals: {
                      "s3:x-amz-acl": "bucket-owner-full-control",
                      "aws:SourceAccount": accountId,
                    },
                    ArnLike: { "aws:SourceArn": trailArn },
                  },
                },
              ],
            });
          }),
      },
      { parent: this, dependsOn: [this.publicAccessBlock] },
    );

    this.trail = new aws.cloudtrail.Trail(
      `${name}-trail`,
      {
        name: trailName,
        s3BucketName: this.archiveBucket.bucket,
        includeGlobalServiceEvents: false,
        isMultiRegionTrail: false,
        enableLogFileValidation: true,
        eventSelectors: [
          {
            // WriteOnly, not All: reads are the highest-volume operation on a live
            // alert path, and this trail is for mutations, not read auditing.
            readWriteType: "WriteOnly",
            includeManagementEvents: false,
            dataResources: [
              {
                type: "AWS::DynamoDB::Table",
                values: [args.alertingTableArn],
              },
            ],
          },
        ],
      },
      { parent: this, dependsOn: [this.bucketPolicy] },
    );

    this.registerOutputs({
      archiveBucketName: this.archiveBucket.bucket,
      trailName: this.trail.name,
    });
  }
}
