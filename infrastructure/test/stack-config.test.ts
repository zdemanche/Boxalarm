import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { REQUIRED_CONFIG } from "../components/shared/stack-config";

const repoRoot = join(__dirname, "..");
const environments = ["dev", "qa", "staging", "prod"] as const;

const load = (file: string) => parse(readFileSync(join(repoRoot, file), "utf8"));

describe("Pulumi project", () => {
  it("declares the boxalarm-infra nodejs/typescript project", () => {
    const project = load("Pulumi.yaml");
    expect(project.name).toBe("boxalarm-infra");
    expect(project.runtime.name).toBe("nodejs");
    expect(project.runtime.options.typescript).toBe(true);
  });
});

const webOriginByEnv: Record<(typeof environments)[number], string> = {
  dev: "https://localhost:5173",
  qa: "https://qa.boxalarm.example",
  staging: "https://staging.boxalarm.example",
  prod: "https://app.boxalarm.example",
};

describe.each(environments)("Pulumi.%s.yaml", (env) => {
  const stack = load(`Pulumi.${env}.yaml`);

  it("names its own environment", () => {
    expect(stack.config["boxalarm-infra:env"]).toBe(env);
  });

  it("pins a U.S. AWS region", () => {
    expect(stack.config["aws:region"]).toMatch(/^us-(east|west)-\d$/);
  });

  it("commits no secret-valued key (secrets are set with --secret, never in the file)", () => {
    for (const key of Object.keys(stack.config)) {
      expect(key).not.toMatch(/Secret$|canaryMemberId/);
    }
  });

  it("documents every required key it does not set, with its set command", () => {
    const text = readFileSync(join(repoRoot, `Pulumi.${env}.yaml`), "utf8");
    for (const k of REQUIRED_CONFIG) {
      if (stack.config[`boxalarm-infra:${k.key}`] !== undefined) continue;
      expect(text, k.key).toContain(`pulumi config set ${k.secret ? "--secret " : ""}${k.key} `);
    }
  });

  it("declares an https webOrigin for Cognito callback/logout URLs", () => {
    const webOrigin = stack.config["boxalarm-infra:webOrigin"] as string;
    expect(webOrigin).toBe(webOriginByEnv[env]);
    expect(webOrigin).toMatch(/^https:\/\//);
  });
});

describe("dev small-roster threshold (deploy-readiness m5)", () => {
  it("pages on fewer than 1 eligible member on dev, the default elsewhere", () => {
    expect(load("Pulumi.dev.yaml").config["boxalarm-infra:alertingMinEligibleMembers"]).toBe("1");
    for (const env of ["qa", "staging", "prod"]) {
      expect(
        load(`Pulumi.${env}.yaml`).config["boxalarm-infra:alertingMinEligibleMembers"],
      ).toBeUndefined();
    }
  });
});
