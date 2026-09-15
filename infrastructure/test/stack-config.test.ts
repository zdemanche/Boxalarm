import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

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

  it("declares an https webOrigin for Cognito callback/logout URLs", () => {
    const webOrigin = stack.config["boxalarm-infra:webOrigin"] as string;
    expect(webOrigin).toBe(webOriginByEnv[env]);
    expect(webOrigin).toMatch(/^https:\/\//);
  });
});
