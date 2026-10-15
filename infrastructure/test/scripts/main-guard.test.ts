import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const INFRASTRUCTURE = path.resolve(__dirname, "../..");
let linkDir: string;

beforeEach(() => {
  linkDir = fs.mkdtempSync(path.join(os.tmpdir(), "main-guard-"));
  fs.symlinkSync(INFRASTRUCTURE, path.join(linkDir, "infrastructure"));
});

afterEach(() => {
  fs.rmSync(linkDir, { recursive: true, force: true });
});

describe.each(["preflight.mjs", "check-alarm-subscriptions.mjs"])("%s", (script) => {
  it("runs its checks, not silently exit 0, when invoked through a symlinked path", () => {
    const result = spawnSync("node", [path.join(linkDir, "infrastructure/scripts", script)], {
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).not.toBe("");
  });
});
