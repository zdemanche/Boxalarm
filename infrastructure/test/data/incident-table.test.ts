import { beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";

beforeEach(() => {
  pulumi.runtime.setMocks({
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      const state: Record<string, unknown> = { ...args.inputs };
      if (args.type === "aws:kms/key:Key") {
        state.arn = `arn:aws:kms:us-east-1:123456789012:key/${args.name}-key-id`;
      }
      if (args.type === "aws:dynamodb/table:Table") {
        state.arn = `arn:aws:dynamodb:us-east-1:123456789012:table/${args.inputs.name}`;
        state.streamArn = `arn:aws:dynamodb:us-east-1:123456789012:table/${args.inputs.name}/stream/2026-01-01T00:00:00.000`;
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
      return args.inputs;
    },
  });
});

async function resolve<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((res) => output.apply(res));
}

async function settle(t: {
  table: {
    id: pulumi.Output<string>;
    arn: pulumi.Output<string>;
    streamArn: pulumi.Output<string>;
    serverSideEncryption: pulumi.Output<unknown>;
  };
  cmk: { arn: pulumi.Output<string>; policy: pulumi.Output<string> };
  tableArn: pulumi.Output<string>;
  streamArn: pulumi.Output<string>;
  cmkArn: pulumi.Output<string>;
}): Promise<void> {
  await Promise.all([
    resolve(t.table.id),
    resolve(t.table.arn),
    resolve(t.table.streamArn),
    resolve(t.table.serverSideEncryption),
    resolve(t.cmk.arn),
    resolve(t.cmk.policy),
    resolve(t.tableArn),
    resolve(t.streamArn),
    resolve(t.cmkArn),
  ]);
  // Let ComponentResource.registerOutputs finish before the next beforeEach swaps mocks.
  await new Promise((r) => setImmediate(r));
}

describe("IncidentTable", () => {
  it("names the table boxalarm-{env}-incident-service with on-demand billing, PITR, and NEW_AND_OLD_IMAGES streams", async () => {
    const { IncidentTable } = await import("../../components/data/incident-table");
    const incident = new IncidentTable("incident", { env: "dev" });
    await settle(incident);

    const [name, billing, pitr, streamEnabled, streamView] = await Promise.all([
      resolve(incident.table.name),
      resolve(incident.table.billingMode),
      resolve(incident.table.pointInTimeRecovery),
      resolve(incident.table.streamEnabled),
      resolve(incident.table.streamViewType),
    ]);

    expect(name).toBe("boxalarm-dev-incident-service");
    expect(billing).toBe("PAY_PER_REQUEST");
    expect(pitr?.enabled).toBe(true);
    expect(streamEnabled).toBe(true);
    expect(streamView).toBe("NEW_AND_OLD_IMAGES");
  });

  it("encrypts with a customer-managed KMS key that allows DynamoDB", async () => {
    const { IncidentTable } = await import("../../components/data/incident-table");
    const incident = new IncidentTable("incident-cmk", { env: "qa" });
    await settle(incident);

    const [sse, cmkArn, policy] = await Promise.all([
      resolve(incident.table.serverSideEncryption),
      resolve(incident.cmk.arn),
      resolve(incident.cmk.policy as pulumi.Output<string>),
    ]);

    expect(sse?.enabled).toBe(true);
    expect(sse?.kmsKeyArn).toBe(cmkArn);
    expect(policy).toContain("dynamodb.amazonaws.com");
    expect(await resolve(incident.tableArn)).toContain("incident-service");
    expect(await resolve(incident.streamArn)).toContain("stream");
    expect(await resolve(incident.cmkArn)).toBe(cmkArn);
  });

  it("declares GSI1 on gsi1pk/gsi1sk with ALL projection for DEPT#{deptId}/INCIDENT#{alarmAt}", async () => {
    const { IncidentTable } = await import("../../components/data/incident-table");
    const incident = new IncidentTable("incident-gsi", { env: "staging" });
    await settle(incident);

    const [attrs, gsis] = await Promise.all([
      resolve(incident.table.attributes),
      resolve(incident.table.globalSecondaryIndexes),
    ]);

    const names = (attrs ?? []).map((a) => a.name);
    expect(names).toEqual(expect.arrayContaining(["pk", "sk", "gsi1pk", "gsi1sk"]));

    const gsi1 = (gsis ?? []).find((g) => g.name === "GSI1");
    expect(gsi1?.hashKey).toBe("gsi1pk");
    expect(gsi1?.rangeKey).toBe("gsi1sk");
    expect(gsi1?.projectionType).toBe("ALL");
  });

  it("throws on absent or unknown env", async () => {
    const { IncidentTable } = await import("../../components/data/incident-table");
    expect(() => new IncidentTable("bad", { env: "" })).toThrow(/env is required/);
    expect(() => new IncidentTable("bad2", { env: "production" })).toThrow(/unknown env/);
  });
});
