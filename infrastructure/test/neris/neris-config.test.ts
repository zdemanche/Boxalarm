import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";

beforeEach(() => {
  pulumi.runtime.setMocks({
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      const state: Record<string, unknown> = { ...args.inputs };
      if (args.type === "aws:secretsmanager/secret:Secret") {
        state.arn = `arn:aws:secretsmanager:us-east-1:123456789012:secret:${args.name}-AbCdEf`;
      }
      if (args.type === "aws:ssm/parameter:Parameter") {
        state.arn = `arn:aws:ssm:us-east-1:123456789012:parameter${args.inputs.name}`;
      }
      return { id: `${args.name}-id`, state };
    },
    call: (args: pulumi.runtime.MockCallArgs) => args.inputs,
  });
});

async function resolve<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((res) => output.apply(res));
}

async function settle(cfg: {
  secret: { arn: pulumi.Output<string> };
  baseUrlParameter: { name: pulumi.Output<string> };
  userAgentParameter: { name: pulumi.Output<string> };
}): Promise<void> {
  await Promise.all([
    resolve(cfg.secret.arn),
    resolve(cfg.baseUrlParameter.name),
    resolve(cfg.userAgentParameter.name),
  ]);
  await new Promise((r) => setImmediate(r));
}

describe("NerisConfig", () => {
  it("AC1: provisions distinct User-Agent and secret name per environment", async () => {
    const { NerisConfig } = await import("../../components/neris/neris-config");

    const envs = ["dev", "qa", "staging", "prod"] as const;
    const userAgents = new Set<string>();
    const secretNames = new Set<string>();

    for (const env of envs) {
      const cfg = new NerisConfig(`neris-${env}`, { env });
      await settle(cfg);

      const [ua, secretName] = await Promise.all([
        resolve(cfg.userAgentParameter.value as pulumi.Output<string>),
        resolve(cfg.secret.name),
      ]);
      expect(ua).toBe(`Boxalarm/${env}`);
      expect(secretName).toBe(`boxalarm-${env}-neris-client-credentials`);
      userAgents.add(ua);
      secretNames.add(secretName);
    }

    expect(userAgents.size).toBe(4);
    expect(secretNames.size).toBe(4);
  });

  it("AC2: non-prod environments hardcode the NERIS dev host, never the prod host", async () => {
    const { NerisConfig, NERIS_DEV_BASE_URL, NERIS_PROD_BASE_URL, nerisBaseUrlForEnv } =
      await import("../../components/neris/neris-config");

    expect(NERIS_DEV_BASE_URL).not.toBe(NERIS_PROD_BASE_URL);
    expect(NERIS_PROD_BASE_URL).toContain("api.neris.fsri.org");
    expect(NERIS_DEV_BASE_URL).not.toContain("://api.neris.fsri.org");

    for (const env of ["dev", "qa", "staging"] as const) {
      expect(nerisBaseUrlForEnv(env)).toBe(NERIS_DEV_BASE_URL);
      expect(nerisBaseUrlForEnv(env)).not.toBe(NERIS_PROD_BASE_URL);

      const cfg = new NerisConfig(`neris-url-${env}`, { env });
      await settle(cfg);
      const baseUrl = await resolve(cfg.baseUrlParameter.value as pulumi.Output<string>);
      expect(baseUrl).toBe(NERIS_DEV_BASE_URL);
      expect(baseUrl).not.toBe(NERIS_PROD_BASE_URL);
    }

    expect(nerisBaseUrlForEnv("prod")).toBe(NERIS_PROD_BASE_URL);
    const prod = new NerisConfig("neris-url-prod", { env: "prod" });
    await settle(prod);
    expect(await resolve(prod.baseUrlParameter.value as pulumi.Output<string>)).toBe(
      NERIS_PROD_BASE_URL,
    );
  });

  it("throws rather than allowing an unknown env to pick a NERIS host", async () => {
    const { NerisConfig, nerisBaseUrlForEnv } = await import("../../components/neris/neris-config");
    expect(() => nerisBaseUrlForEnv("production")).toThrow(/unknown env/);
    expect(() => new NerisConfig("neris-bad", { env: "production" })).toThrow(/unknown env/);
  });

  it("stores SSM params under /boxalarm/{env}/neris/ and leaves secret values out-of-band (no SecretVersion)", async () => {
    const { NerisConfig } = await import("../../components/neris/neris-config");
    const cfg = new NerisConfig("neris-paths", { env: "dev" });
    await settle(cfg);

    const [baseName, uaName, secretName] = await Promise.all([
      resolve(cfg.baseUrlParameter.name),
      resolve(cfg.userAgentParameter.name),
      resolve(cfg.secret.name),
    ]);

    expect(baseName).toBe("/boxalarm/dev/neris/base-url");
    expect(uaName).toBe("/boxalarm/dev/neris/user-agent");
    expect(secretName).toBe("boxalarm-dev-neris-client-credentials");
    // No Pulumi-managed SecretVersion — operators put OAuth values out-of-band.
    expect(cfg).not.toHaveProperty("secretVersion");
  });

  it("source never creates a SecretVersion that would wipe out-of-band credentials on deploy", () => {
    const component = readFileSync(
      join(__dirname, "../../components/neris/neris-config.ts"),
      "utf8",
    );
    expect(component).not.toMatch(
      /secretsmanager\.SecretVersion|new aws\.secretsmanager\.SecretVersion/,
    );
  });

  it("exports IAM statements scoped to the secret and /boxalarm/{env}/neris/* SSM path", async () => {
    const { nerisClientPolicyStatements } = await import("../../components/neris/neris-config");
    const statements = nerisClientPolicyStatements(
      "arn:aws:secretsmanager:us-east-1:123456789012:secret:boxalarm-dev-neris-client-credentials-AbCdEf",
      "dev",
    );

    const secretStmt = statements.find((s) => s.Sid === "NerisGetSecretValue");
    expect(secretStmt?.Effect).toBe("Allow");
    expect(secretStmt?.Action).toEqual(["secretsmanager:GetSecretValue"]);
    expect(secretStmt?.Resource).toContain("neris-client-credentials");

    const ssmStmt = statements.find((s) => s.Sid === "NerisGetParameters");
    expect(ssmStmt?.Action).toEqual(["ssm:GetParameter", "ssm:GetParameters"]);
    expect(ssmStmt?.Resource).toContain("/boxalarm/dev/neris/*");
  });
});

describe("NERIS config source hygiene", () => {
  it("does not embed plaintext OAuth client credentials in the component or stack configs", () => {
    const component = readFileSync(
      join(__dirname, "../../components/neris/neris-config.ts"),
      "utf8",
    );
    expect(component).not.toMatch(/client_secret\s*[:=]\s*["'][^"']+["']/i);
    expect(component).not.toMatch(/client_id\s*[:=]\s*["'][A-Za-z0-9_-]{8,}["']/i);

    for (const env of ["dev", "qa", "staging", "prod"]) {
      const stack = readFileSync(join(__dirname, `../../Pulumi.${env}.yaml`), "utf8");
      expect(stack).not.toMatch(/neris.*secret|client_secret|client_id/i);
    }
  });
});
