import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Review MINOR 11: the script spliced --dept-id into a JMESPath query unescaped, and on a
 * 409 (a login already exists for the email) silently promoted that existing member to
 * ADMIN/CHIEF. Runs the real script against a fake `aws` on PATH.
 */
const SCRIPT = path.resolve(__dirname, "../../scripts/bootstrap-first-admin.sh");

const BASE_ARGS = [
  "dev",
  "--email",
  "chief@example.org",
  "--first-name",
  "Pat",
  "--last-name",
  "Doe",
  "--phone",
  "+12035550100",
  "--rank",
  "Chief",
  "--agency-id",
  "NICHOLS-FD",
  "--yes",
];

let binDir: string;
let callLog: string;

// Answers just enough of the AWS CLI for the script to reach the 409 resume branch: an
// empty ADMIN/CHIEF group, a create Lambda that answers 409, and an existing login whose
// status the test chooses.
function writeFakeAws(userStatus: string): void {
  const fake = `#!/usr/bin/env bash
echo "$*" >> "${callLog}"
case "$1 $2" in
  "lambda get-function-configuration") echo "us-east-1_pool" ;;
  "cognito-idp list-users-in-group") echo '{"Users":[]}' ;;
  "lambda invoke")
    for last; do :; done
    echo '{"statusCode":409,"body":"{}"}' > "$last" ;;
  "cognito-idp admin-get-user")
    echo '{"UserStatus":"${userStatus}","UserAttributes":[{"Name":"custom:deptId","Value":"NICHOLS"},{"Name":"sub","Value":"sub-1"}]}' ;;
  *) echo "unexpected aws call: $*" >&2; exit 99 ;;
esac
`;
  fs.writeFileSync(path.join(binDir, "aws"), fake, { mode: 0o755 });
}

function run(args: string[]) {
  return spawnSync("bash", [SCRIPT, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
  });
}

function awsCalls(): string {
  return fs.existsSync(callLog) ? fs.readFileSync(callLog, "utf8") : "";
}

beforeEach(() => {
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-test-"));
  callLog = path.join(binDir, "calls.log");
});

afterEach(() => {
  fs.rmSync(binDir, { recursive: true, force: true });
});

describe("bootstrap-first-admin.sh", () => {
  it.each(["NICHOLS']", "a#MEMBER#b", "has space", "x".repeat(65), ""])(
    "rejects an unsafe --dept-id %j before any AWS call",
    (deptId) => {
      writeFakeAws("FORCE_CHANGE_PASSWORD");
      const result = run([...BASE_ARGS, "--dept-id", deptId]);

      expect(result.status).toBe(2);
      expect(awsCalls()).toBe("");
    },
  );

  it("refuses to promote an existing login unless --resume is passed", () => {
    writeFakeAws("FORCE_CHANGE_PASSWORD");
    const result = run([...BASE_ARGS, "--dept-id", "NICHOLS"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("re-run with --resume");
    expect(awsCalls()).not.toContain("members-update-roles");
  });

  it("refuses --resume for a login that has already signed in (an existing member)", () => {
    writeFakeAws("CONFIRMED");
    const result = run([...BASE_ARGS, "--dept-id", "NICHOLS", "--resume"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("has already signed in");
    expect(awsCalls()).not.toContain("members-update-roles");
  });

  it("resumes an unfinished bootstrap (never signed in) when --resume is passed", () => {
    writeFakeAws("FORCE_CHANGE_PASSWORD");
    const result = run([...BASE_ARGS, "--dept-id", "NICHOLS", "--resume"]);

    // The fake answers 409 to the roles invoke too, so the run fails there - after the
    // resume branch has accepted the login and moved on to assigning the role.
    expect(result.stdout).toContain("resuming");
    expect(awsCalls()).toContain("members-update-roles");
  });
});
