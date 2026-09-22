import { beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";

beforeEach(() => {
  pulumi.runtime.setMocks({
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      const state: Record<string, unknown> = { ...args.inputs };
      if (args.type === "aws:s3/bucket:Bucket" || args.type === "aws:s3/bucketV2:BucketV2") {
        state.arn = `arn:aws:s3:::${args.inputs.bucket ?? args.name}`;
        state.bucket = args.inputs.bucket ?? args.name;
      }
      if (args.type === "aws:cloudtrail/trail:Trail") {
        state.arn = `arn:aws:cloudtrail:us-east-1:123456789012:trail/${args.name}`;
      }
      return { id: `${args.name}-id`, state };
    },
    call: (args: pulumi.runtime.MockCallArgs) => {
      if (args.token === "aws:index/getCallerIdentity:getCallerIdentity") {
        return {
          accountId: "123456789012",
          arn: "arn:aws:iam::123456789012:root",
          userId: "AIDATEST",
        };
      }
      if (args.token === "aws:index/getRegion:getRegion") {
        return { name: "us-east-1", description: "US East (N. Virginia)", id: "us-east-1" };
      }
      return args.inputs;
    },
  });
});

async function resolve<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((res) => output.apply(res));
}

async function settle(a: {
  archiveBucket: { id: pulumi.Output<string>; arn: pulumi.Output<string> };
  publicAccessBlock: {
    id: pulumi.Output<string>;
    blockPublicAcls: pulumi.Output<boolean | undefined>;
  };
  versioning: { id: pulumi.Output<string> };
  objectLockConfiguration: { id: pulumi.Output<string>; rule: pulumi.Output<unknown> };
  bucketPolicy: { id: pulumi.Output<string> };
  trail: { id: pulumi.Output<string>; eventSelectors: pulumi.Output<unknown> };
}): Promise<void> {
  await Promise.all([
    resolve(a.archiveBucket.id),
    resolve(a.archiveBucket.arn),
    resolve(a.publicAccessBlock.id),
    resolve(a.publicAccessBlock.blockPublicAcls),
    resolve(a.versioning.id),
    resolve(a.objectLockConfiguration.id),
    resolve(a.objectLockConfiguration.rule),
    resolve(a.bucketPolicy.id),
    resolve(a.trail.id),
    resolve(a.trail.eventSelectors),
  ]);
  await new Promise((r) => setImmediate(r));
}

describe("AuditTrail", () => {
  it("creates an Object Lock compliance archive bucket with public access blocked", async () => {
    const { AuditTrail } = await import("../../components/data/audit-trail");
    const audit = new AuditTrail("audit", {
      env: "dev",
      alertingTableArn: "arn:aws:dynamodb:us-east-1:123456789012:table/boxalarm-dev-alerting-table",
    });
    await settle(audit);

    const [bucketName, objectLockEnabled, block] = await Promise.all([
      resolve(audit.archiveBucket.bucket),
      resolve(audit.archiveBucket.objectLockEnabled),
      resolve(audit.publicAccessBlock.blockPublicAcls),
    ]);

    expect(bucketName).toBe("boxalarm-dev-audit-archive");
    expect(objectLockEnabled).toBe(true);
    expect(block).toBe(true);
    expect(await resolve(audit.objectLockConfiguration.rule)).toMatchObject({
      defaultRetention: expect.objectContaining({ mode: "COMPLIANCE" }),
    });
  });

  it("captures DynamoDB data events for the alerting table, mutations only (WriteOnly)", async () => {
    const { AuditTrail } = await import("../../components/data/audit-trail");
    const tableArn =
      "arn:aws:dynamodb:us-east-1:123456789012:table/boxalarm-staging-alerting-table";
    const audit = new AuditTrail("audit-events", {
      env: "staging",
      alertingTableArn: tableArn,
    });
    await settle(audit);

    const selectors = await resolve(audit.trail.eventSelectors);
    const dataResources = selectors?.[0]?.dataResources ?? [];
    const dynamo = dataResources.find((d) => d.type === "AWS::DynamoDB::Table");
    expect(dynamo?.values).toContain(tableArn);
    // Reads are the highest-volume op on a live alert path — must not be captured
    // into the 365-day COMPLIANCE-locked bucket (cost is a hard constraint).
    expect(selectors?.[0]?.readWriteType).toBe("WriteOnly");
  });

  it("transitions archive objects to Glacier Instant Retrieval and expires them after the lock elapses", async () => {
    const { AuditTrail, AUDIT_LIFECYCLE_GLACIER_TRANSITION_DAYS, AUDIT_LIFECYCLE_EXPIRATION_DAYS } =
      await import("../../components/data/audit-trail");
    const audit = new AuditTrail("audit-lifecycle", {
      env: "dev",
      alertingTableArn: "arn:aws:dynamodb:us-east-1:123456789012:table/boxalarm-dev-alerting-table",
    });
    await settle(audit);

    const rules = await resolve(audit.lifecycleConfiguration.rules);
    expect(rules).toHaveLength(1);
    expect(rules?.[0]?.status).toBe("Enabled");
    expect(rules?.[0]?.transitions?.[0]).toMatchObject({
      days: AUDIT_LIFECYCLE_GLACIER_TRANSITION_DAYS,
      storageClass: "GLACIER_IR",
    });
    expect(rules?.[0]?.expiration?.days).toBe(AUDIT_LIFECYCLE_EXPIRATION_DAYS);
    // Must expire strictly after the Object Lock retention elapses.
    expect(AUDIT_LIFECYCLE_EXPIRATION_DAYS).toBeGreaterThan(365);
  });

  it("pins CloudTrail PutObject to this trail ARN and account (confused-deputy hardening)", async () => {
    const { AuditTrail } = await import("../../components/data/audit-trail");
    const audit = new AuditTrail("audit-policy", {
      env: "dev",
      alertingTableArn: "arn:aws:dynamodb:us-east-1:123456789012:table/boxalarm-dev-alerting-table",
    });
    await settle(audit);

    const policyJson = await resolve(audit.bucketPolicy.policy);
    const policy = JSON.parse(policyJson as string) as {
      Statement: Array<{ Sid: string; Condition?: Record<string, Record<string, string>> }>;
    };
    const write = policy.Statement.find((s) => s.Sid === "AWSCloudTrailWrite");
    expect(write?.Condition?.StringEquals?.["aws:SourceAccount"]).toBe("123456789012");
    expect(write?.Condition?.ArnLike?.["aws:SourceArn"]).toBe(
      "arn:aws:cloudtrail:us-east-1:123456789012:trail/boxalarm-dev-alerting-data-events",
    );
  });

  it("throws on absent or unknown env", async () => {
    const { AuditTrail } = await import("../../components/data/audit-trail");
    expect(
      () =>
        new AuditTrail("bad", {
          env: "",
          alertingTableArn: "arn:aws:dynamodb:us-east-1:123456789012:table/x",
        }),
    ).toThrow(/env is required/);
  });
});
