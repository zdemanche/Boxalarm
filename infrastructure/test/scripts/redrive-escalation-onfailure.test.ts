import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = path.resolve(__dirname, "../../scripts/redrive-escalation-onfailure.sh");
const ACCOUNT = "111122223333";
const fnArn = (name: string, qualifier = "$LATEST") =>
  `arn:aws:lambda:us-east-1:${ACCOUNT}:function:${name}:${qualifier}`;
const record = (functionArn: string, requestPayload?: unknown) =>
  JSON.stringify({
    requestContext: { functionArn, condition: "RetriesExhausted" },
    ...(requestPayload === undefined ? {} : { requestPayload }),
  });

const MESSAGES = [
  {
    MessageId: "m-ok",
    ReceiptHandle: "r-ok",
    Body: record(fnArn("boxalarm-dev-alerting-escalation"), { tone: 2 }),
  },
  {
    MessageId: "m-prod",
    ReceiptHandle: "r-prod",
    Body: record(fnArn("boxalarm-prod-alerting-escalation"), { tone: 2 }),
  },
  {
    MessageId: "m-foreign",
    ReceiptHandle: "r-foreign",
    Body: record(fnArn("some-other-function"), { x: 1 }),
  },
  { MessageId: "m-text", ReceiptHandle: "r-text", Body: "not json" },
  {
    MessageId: "m-nopayload",
    ReceiptHandle: "r-nopayload",
    Body: record(fnArn("boxalarm-dev-alerting-tone-evaluator")),
  },
];

let binDir: string;
let callLog: string;

function writeFakeAws(invokeFails = false, messages: unknown[] = MESSAGES): void {
  const batch = JSON.stringify({ Messages: messages });
  const fake = `#!/usr/bin/env bash
echo "$*" >> "${callLog}"
case "$1 $2" in
  "sqs get-queue-url") echo "https://sqs.example/queue" ;;
  "sqs receive-message")
    if [[ -e "${binDir}/received" ]]; then echo '{}'; else touch "${binDir}/received"; echo '${batch}'; fi ;;
  "lambda invoke") ${invokeFails ? "exit 1" : "exit 0"} ;;
  "sqs delete-message") exit 0 ;;
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

const calls = () => fs.readFileSync(callLog, "utf8").split("\n").filter(Boolean);

beforeEach(() => {
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), "redrive-test-"));
  callLog = path.join(binDir, "calls.log");
});

afterEach(() => {
  fs.rmSync(binDir, { recursive: true, force: true });
});

describe("redrive-escalation-onfailure.sh", () => {
  it("re-invokes then deletes only allow-listed records with a payload, leaving the rest", () => {
    writeFakeAws();
    const result = run(["dev"]);

    expect(result.status).toBe(0);
    const log = calls();
    const invokes = log.filter((line) => line.startsWith("lambda invoke"));
    expect(invokes).toHaveLength(1);
    expect(invokes[0]).toContain("boxalarm-dev-alerting-escalation:$LATEST");
    const deletes = log.filter((line) => line.startsWith("sqs delete-message"));
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toContain("r-ok");
    expect(log.indexOf(invokes[0])).toBeLessThan(log.indexOf(deletes[0]));
    expect(result.stderr.match(/LEFT ON QUEUE/g)).toHaveLength(4);
  });

  it("deletes nothing when the re-invoke fails", () => {
    writeFakeAws(true);
    const result = run(["dev"]);

    expect(result.status).not.toBe(0);
    expect(calls().some((line) => line.startsWith("sqs delete-message"))).toBe(false);
  });

  it("makes no invoke or delete in a dry run", () => {
    writeFakeAws();
    const result = run(["dev", "--dry-run"]);

    expect(result.status).toBe(0);
    expect(calls().some((line) => /^(lambda invoke|sqs delete-message)/.test(line))).toBe(false);
  });

  it("drains the Scheduler dead-letter queue using TARGET_ARN and the body, allow-listed", () => {
    const attr = (arn: string) => ({
      TARGET_ARN: { DataType: "String", StringValue: arn },
      ERROR_CODE: { DataType: "String", StringValue: "AccessDenied" },
    });
    writeFakeAws(false, [
      {
        MessageId: "s-ok",
        ReceiptHandle: "r-s-ok",
        Body: '{"tone":3}',
        MessageAttributes: attr(fnArn("boxalarm-dev-alerting-tone-evaluator")),
      },
      {
        MessageId: "s-foreign",
        ReceiptHandle: "r-s-foreign",
        Body: '{"x":1}',
        MessageAttributes: attr(fnArn("some-other-function")),
      },
    ]);
    const result = run(["dev", "--schedule-dlq"]);

    expect(result.status).toBe(0);
    const log = calls();
    expect(log.find((line) => line.startsWith("sqs get-queue-url"))).toContain(
      "alerting-schedule-dlq",
    );
    const invokes = log.filter((line) => line.startsWith("lambda invoke"));
    expect(invokes).toHaveLength(1);
    expect(invokes[0]).toContain("boxalarm-dev-alerting-tone-evaluator:$LATEST");
    expect(invokes[0]).toContain('{"tone":3}');
    const deletes = log.filter((line) => line.startsWith("sqs delete-message"));
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toContain("r-s-ok");
    expect(result.stderr.match(/LEFT ON QUEUE/g)).toHaveLength(1);
  });
});
