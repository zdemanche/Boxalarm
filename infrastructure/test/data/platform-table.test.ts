import { beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";

beforeEach(() => {
  pulumi.runtime.setMocks({
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      const state: Record<string, unknown> = { ...args.inputs };
      if (args.type === "aws:dynamodb/table:Table") {
        state.arn = `arn:aws:dynamodb:us-east-1:123456789012:table/${args.inputs.name}`;
        state.streamArn = `arn:aws:dynamodb:us-east-1:123456789012:table/${args.inputs.name}/stream/2026-01-01T00:00:00.000`;
      }
      return { id: `${args.name}-id`, state };
    },
    call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
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
    globalSecondaryIndexes: pulumi.Output<unknown>;
  };
  tableArn: pulumi.Output<string>;
  streamArn: pulumi.Output<string>;
}): Promise<void> {
  await Promise.all([
    resolve(t.table.id),
    resolve(t.table.arn),
    resolve(t.table.streamArn),
    resolve(t.table.serverSideEncryption),
    resolve(t.table.globalSecondaryIndexes),
    resolve(t.tableArn),
    resolve(t.streamArn),
  ]);
  await new Promise((r) => setImmediate(r));
}

describe("PlatformTable", () => {
  it("names the table boxalarm-{env}-platform-service with on-demand, PITR, and NEW_AND_OLD_IMAGES", async () => {
    const { PlatformTable } = await import("../../components/data/platform-table");
    const platform = new PlatformTable("platform", { env: "dev" });
    await settle(platform);

    const [name, billing, pitr, streamView, sse] = await Promise.all([
      resolve(platform.table.name),
      resolve(platform.table.billingMode),
      resolve(platform.table.pointInTimeRecovery),
      resolve(platform.table.streamViewType),
      resolve(platform.table.serverSideEncryption),
    ]);

    expect(name).toBe("boxalarm-dev-platform-service");
    expect(billing).toBe("PAY_PER_REQUEST");
    expect(pitr?.enabled).toBe(true);
    expect(streamView).toBe("NEW_AND_OLD_IMAGES");
    // AWS-managed KMS (enabled, no customer kmsKeyArn)
    expect(sse?.enabled).toBe(true);
    expect(sse?.kmsKeyArn).toBeUndefined();
  });

  it("declares GSI1/GSI2/GSI3 with ALL projection", async () => {
    const { PlatformTable } = await import("../../components/data/platform-table");
    const platform = new PlatformTable("platform-gsi", { env: "prod" });
    await settle(platform);

    const [attrs, gsis] = await Promise.all([
      resolve(platform.table.attributes),
      resolve(platform.table.globalSecondaryIndexes),
    ]);

    const names = (attrs ?? []).map((a) => a.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "pk",
        "sk",
        "gsi1pk",
        "gsi1sk",
        "gsi2pk",
        "gsi2sk",
        "gsi3pk",
        "gsi3sk",
      ]),
    );

    for (const idx of ["GSI1", "GSI2", "GSI3"]) {
      const gsi = (gsis ?? []).find((g) => g.name === idx);
      expect(gsi?.projectionType).toBe("ALL");
    }
    expect((gsis ?? []).find((g) => g.name === "GSI1")?.hashKey).toBe("gsi1pk");
    expect((gsis ?? []).find((g) => g.name === "GSI2")?.hashKey).toBe("gsi2pk");
    expect((gsis ?? []).find((g) => g.name === "GSI3")?.hashKey).toBe("gsi3pk");
  });

  it("exports auditMutationDenyStatement denying UpdateItem/DeleteItem on DEPT#*#AUDIT#* leading keys", async () => {
    const { auditMutationDenyStatement } = await import("../../components/data/platform-table");
    const stmt = auditMutationDenyStatement(
      "arn:aws:dynamodb:us-east-1:123456789012:table/boxalarm-dev-platform-service",
    );

    expect(stmt.Effect).toBe("Deny");
    expect(stmt.Action).toEqual(["dynamodb:UpdateItem", "dynamodb:DeleteItem"]);
    expect(stmt.Resource).toContain("platform-service");
    expect(stmt.Condition).toEqual({
      "ForAllValues:StringLike": {
        "dynamodb:LeadingKeys": ["DEPT#*#AUDIT#*"],
      },
    });
  });
});
