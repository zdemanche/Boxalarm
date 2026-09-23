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
    ttl: pulumi.Output<unknown>;
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
    resolve(t.table.ttl),
    resolve(t.table.serverSideEncryption),
    resolve(t.cmk.arn),
    resolve(t.cmk.policy),
    resolve(t.tableArn),
    resolve(t.streamArn),
    resolve(t.cmkArn),
  ]);
  await new Promise((r) => setImmediate(r));
}

describe("AlertingTable", () => {
  it("names the table boxalarm-{env}-alerting-table with on-demand, PITR, NEW_IMAGE streams, and TTL", async () => {
    const { AlertingTable } = await import("../../components/data/alerting-table");
    const alerting = new AlertingTable("alerting", { env: "dev" });
    await settle(alerting);

    const [name, billing, pitr, streamView, ttl, sse, cmkArn] = await Promise.all([
      resolve(alerting.table.name),
      resolve(alerting.table.billingMode),
      resolve(alerting.table.pointInTimeRecovery),
      resolve(alerting.table.streamViewType),
      resolve(alerting.table.ttl),
      resolve(alerting.table.serverSideEncryption),
      resolve(alerting.cmk.arn),
    ]);

    expect(name).toBe("boxalarm-dev-alerting-table");
    expect(billing).toBe("PAY_PER_REQUEST");
    expect(pitr?.enabled).toBe(true);
    expect(streamView).toBe("NEW_IMAGE");
    expect(ttl?.enabled).toBe(true);
    expect(ttl?.attributeName).toBe("ttl");
    expect(sse?.enabled).toBe(true);
    expect(sse?.kmsKeyArn).toBe(cmkArn);
  });

  it("declares GSI1 and GSI2 with ALL projection", async () => {
    const { AlertingTable } = await import("../../components/data/alerting-table");
    const alerting = new AlertingTable("alerting-gsi", { env: "prod" });
    await settle(alerting);

    const [attrs, gsis] = await Promise.all([
      resolve(alerting.table.attributes),
      resolve(alerting.table.globalSecondaryIndexes),
    ]);

    const names = (attrs ?? []).map((a) => a.name);
    expect(names).toEqual(
      expect.arrayContaining(["pk", "sk", "gsi1pk", "gsi1sk", "gsi2pk", "gsi2sk"]),
    );

    const gsi1 = (gsis ?? []).find((g) => g.name === "GSI1");
    const gsi2 = (gsis ?? []).find((g) => g.name === "GSI2");
    expect(gsi1?.hashKey).toBe("gsi1pk");
    expect(gsi1?.rangeKey).toBe("gsi1sk");
    expect(gsi1?.projectionType).toBe("ALL");
    expect(gsi2?.hashKey).toBe("gsi2pk");
    expect(gsi2?.rangeKey).toBe("gsi2sk");
    expect(gsi2?.projectionType).toBe("ALL");
  });

  it("throws on absent or unknown env", async () => {
    const { AlertingTable } = await import("../../components/data/alerting-table");
    expect(() => new AlertingTable("bad", { env: undefined as unknown as string })).toThrow(
      /env is required/,
    );
    expect(() => new AlertingTable("bad2", { env: "production" })).toThrow(/unknown env/);
  });
});
