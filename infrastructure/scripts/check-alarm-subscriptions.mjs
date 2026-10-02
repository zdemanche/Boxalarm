#!/usr/bin/env node
// Post-deploy check that the stack's alarm topics actually reach a person (deploy-readiness
// M3). An SNS *email* subscription stays PendingConfirmation until someone clicks the link in
// the confirmation email; until then every alarm on that topic notifies nobody, silently.
//
// Checks boxalarm-<env>-alerting-page (every alert-path alarm) and
// boxalarm-<env>-chief-notifications (ops alarms, export/disposal notices): each must exist,
// have at least one subscription, and have none still PendingConfirmation.
//
// Usage: node scripts/check-alarm-subscriptions.mjs <dev|qa|staging|prod> [--region us-east-1]
// Read-only (SNS ListTopics / ListSubscriptionsByTopic). Exit 0 = every topic reaches someone,
// 1 = at least one does not, 2 = usage.
import { pathToFileURL } from "node:url";
import { SNSClient, ListTopicsCommand, ListSubscriptionsByTopicCommand } from "@aws-sdk/client-sns";

export const alarmTopicNames = (env) => [
  `boxalarm-${env}-alerting-page`,
  `boxalarm-${env}-chief-notifications`,
];

async function listAll(send, makeCommand, key) {
  const items = [];
  let NextToken;
  do {
    const page = await send(makeCommand(NextToken));
    items.push(...(page[key] ?? []));
    NextToken = page.NextToken;
  } while (NextToken);
  return items;
}

/**
 * @param {{ send: Function }} sns
 * @param {string} env
 * @returns {Promise<{ problems: string[], ok: string[] }>}
 */
export async function checkAlarmSubscriptions(sns, env) {
  const send = (command) => sns.send(command);
  const topics = await listAll(send, (NextToken) => new ListTopicsCommand({ NextToken }), "Topics");
  const problems = [];
  const ok = [];
  for (const name of alarmTopicNames(env)) {
    const topicArn = topics.map((t) => t.TopicArn ?? "").find((arn) => arn.endsWith(`:${name}`));
    if (!topicArn) {
      problems.push(`${name}: topic not found - is the stack deployed to this account/region?`);
      continue;
    }
    const subscriptions = await listAll(
      send,
      (NextToken) => new ListSubscriptionsByTopicCommand({ TopicArn: topicArn, NextToken }),
      "Subscriptions",
    );
    const pending = subscriptions.filter((s) => s.SubscriptionArn === "PendingConfirmation");
    const confirmed = subscriptions.length - pending.length;
    if (subscriptions.length === 0) {
      problems.push(
        `${name}: no subscription - its alarms notify nobody. Set the stack's email config ` +
          `(alertingPageEmail / chiefNotificationEmail) and deploy, or subscribe on-call by hand.`,
      );
    }
    for (const s of pending) {
      problems.push(
        `${name}: ${s.Protocol} subscription for ${s.Endpoint} is still PendingConfirmation - ` +
          `its alarms reach nobody until the confirmation link in that inbox is clicked.`,
      );
    }
    if (subscriptions.length > 0 && pending.length === 0) {
      ok.push(`${name}: ${confirmed} confirmed subscription(s).`);
    }
  }
  return { problems, ok };
}

async function main() {
  const [env, flag, value, ...rest] = process.argv.slice(2);
  const validFlags = flag === undefined || (flag === "--region" && value && rest.length === 0);
  if (!["dev", "qa", "staging", "prod"].includes(env ?? "") || !validFlags) {
    console.error(
      "usage: node scripts/check-alarm-subscriptions.mjs <dev|qa|staging|prod> [--region us-east-1]",
    );
    process.exit(2);
  }
  const region = flag === "--region" ? value : (process.env.AWS_REGION ?? "us-east-1");
  const { problems, ok } = await checkAlarmSubscriptions(new SNSClient({ region }), env);
  for (const line of ok) console.log(line);
  for (const line of problems) console.error(`NOT PAGING: ${line}`);
  if (problems.length > 0) {
    console.error(
      `ALARM ROUTING IS BROKEN for ${env}: the topics above notify nobody. Fix before relying on ` +
        `this stack (docs/runbooks/first-deploy.md, step 5).`,
    );
    process.exit(1);
  }
  console.log(`every alarm topic for ${env} reaches a confirmed subscriber.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`could not check subscriptions: ${error?.message ?? error}`);
    process.exit(1);
  });
}
