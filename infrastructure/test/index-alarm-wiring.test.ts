import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const index = readFileSync(join(root, "index.ts"), "utf8");

const componentFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? componentFiles(path) : path.endsWith(".ts") ? [path] : [];
  });

const classesWithAddAlarms = componentFiles(join(root, "components")).flatMap((file) => {
  const source = readFileSync(file, "utf8");
  return [...source.matchAll(/export class (\w+)[^{]*\{([\s\S]*?)\n\}\n/g)]
    .filter(([, , body]) => /^ {2}addAlarms\(/m.test(body))
    .map(([, name]) => name);
});

describe("index.ts alarm wiring", () => {
  it("finds the components that define addAlarms", () => {
    expect(classesWithAddAlarms).toEqual(expect.arrayContaining(["BoxalarmUserPool", "HttpApi"]));
  });

  it.each(classesWithAddAlarms)(
    "%s.addAlarms is called on an instance created in index.ts",
    (name) => {
      const instances = [...index.matchAll(new RegExp(`const (\\w+) = new ${name}\\(`, "g"))].map(
        ([, instance]) => instance,
      );
      expect(instances.length, `${name} instance in index.ts`).toBeGreaterThan(0);
      expect(
        instances.some((instance) => new RegExp(`\\b${instance}\\.addAlarms\\(`).test(index)),
        `${name}.addAlarms never called`,
      ).toBe(true);
    },
  );
});
