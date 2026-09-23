import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = join(__dirname, "..");
const environments = ["dev", "qa", "staging", "prod"] as const;
const usRegion = /^us-(east|west)-\d$/;

const loadYaml = (file: string) => parse(readFileSync(join(repoRoot, file), "utf8"));
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

describe("N6.1 U.S. residency — stack config", () => {
  it.each(environments)("Pulumi.%s.yaml aws:region matches /^us-(east|west)-\\d$/", (env) => {
    const stack = loadYaml(`Pulumi.${env}.yaml`);
    const region = stack.config["aws:region"] as string;
    expect(
      region,
      `N6.1: aws:region must be a U.S. commercial region (us-east-|us-west-), got ${JSON.stringify(region)}`,
    ).toMatch(usRegion);
  });

  it("fails the residency contract if any stack config mentions a non-US region or CloudFront global edge", () => {
    const forbiddenRegion =
      /\b(eu|ap|af|me|sa|ca|il|mx)-(central|north|south|east|west|northeast|southeast|southwest)?-?\d*\b/i;
    const cloudFrontEdge = /cloudfront|global\s*edge|edge\s*location|CloudFrontDistribution/i;

    for (const env of environments) {
      const raw = read(`Pulumi.${env}.yaml`);
      const stack = loadYaml(`Pulumi.${env}.yaml`);
      const region = String(stack.config["aws:region"] ?? "");

      expect(
        usRegion.test(region),
        `N6.1: Pulumi.${env}.yaml pins a non-U.S. region ${JSON.stringify(region)}`,
      ).toBe(true);

      // Strip the known-good aws:region line before scanning for other region tokens.
      const withoutRegionLine = raw.replace(/^\s*aws:region:.*$/m, "");
      expect(
        withoutRegionLine,
        `N6.1: Pulumi.${env}.yaml must not mention non-U.S. regions`,
      ).not.toMatch(forbiddenRegion);
      expect(
        raw,
        `N6.1: Pulumi.${env}.yaml must not configure CloudFront / global edge`,
      ).not.toMatch(cloudFrontEdge);
    }
  });

  it("fails CI if TypeScript infra introduces CloudFront, global edge, or non-US region literals (N6.1)", () => {
    const forbiddenRegion =
      /\b(eu|ap|af|me|sa|ca|il|mx)-(central|north|south|east|west|northeast|southeast|southwest)-\d+\b/i;
    const cloudFrontEdge = /aws\.cloudfront\.|CloudFrontDistribution|new\s+aws\.cloudfront\./;
    const globalReplica = /replicaRegions|aws\.dynamodb\.GlobalTable|isMultiRegionTrail:\s*true/;

    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          out.push(...walk(full));
        } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
          out.push(full);
        }
      }
      return out;
    };

    const files = walk(join(repoRoot, "components"));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const src = readFileSync(file, "utf8");
      const rel = file.slice(repoRoot.length + 1);
      expect(src, `N6.1: ${rel} must not introduce CloudFront / global edge`).not.toMatch(
        cloudFrontEdge,
      );
      expect(src, `N6.1: ${rel} must not hardcode non-U.S. regions`).not.toMatch(forbiddenRegion);
      expect(src, `N6.1: ${rel} must not enable multi-region replication`).not.toMatch(
        globalReplica,
      );
    }
  });
});

describe("encryption + single-region data plane (static source)", () => {
  it("incident and alerting table modules use customer-managed KMS (sse + kmsKeyArn)", () => {
    const incident = read("components/data/incident-table.ts");
    const alerting = read("components/data/alerting-table.ts");

    for (const [label, src] of [
      ["incident-table", incident],
      ["alerting-table", alerting],
    ] as const) {
      expect(src, label).toMatch(/aws\.kms\.Key/);
      expect(src, label).toMatch(/serverSideEncryption/);
      expect(src, label).toMatch(/kmsKeyArn/);
      expect(src, label).toMatch(/enabled:\s*true/);
    }
  });

  it("platform table uses AWS-managed encryption (sse enabled, no customer kmsKeyArn)", () => {
    const platform = read("components/data/platform-table.ts");
    expect(platform).toMatch(/serverSideEncryption/);
    expect(platform).toMatch(/enabled:\s*true/);
    // Must not assign a customer kmsKeyArn on serverSideEncryption.
    expect(platform).not.toMatch(/kmsKeyArn\s*:/);
    expect(platform).not.toMatch(/aws\.kms\.Key/);
  });

  it("data components do not enable multi-region DynamoDB replicas or global tables", () => {
    const dataDir = join(repoRoot, "components/data");
    const files = readdirSync(dataDir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const src = read(`components/data/${file}`);
      expect(src, file).not.toMatch(/\breplicas\s*:/);
      expect(src, file).not.toMatch(/replicaRegion|globalTable|GlobalTable/i);
      expect(src, file).not.toMatch(/aws\.dynamodb\.GlobalTable/);
    }
  });
});
