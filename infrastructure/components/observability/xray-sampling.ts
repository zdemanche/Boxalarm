import * as aws from "@pulumi/aws";

// ponytail: no Lambda component exists yet in this repo (Lambda-per-route lands in a
// later story). The future Lambda component MUST set tracingConfig to this value for
// every route Lambda — X-Ray is the alert-path diagnostic tool (architecture.md:437).
export const ACTIVE_TRACING_CONFIG = { mode: "Active" } as const;

function requireEnv(fn: string, env: string): void {
  if (typeof env !== "string" || env.length === 0) {
    throw new Error(`${fn}: env is required (received ${JSON.stringify(env)})`);
  }
}

export function createDefaultSamplingRule(env: string): aws.xray.SamplingRule {
  requireEnv("createDefaultSamplingRule", env);

  return new aws.xray.SamplingRule(`boxalarm-${env}-default-sampling`, {
    ruleName: `boxalarm-${env}-default-sampling`,
    priority: 1000,
    fixedRate: 0.05,
    reservoirSize: 1,
    resourceArn: "*",
    serviceType: "*",
    serviceName: "*",
    host: "*",
    httpMethod: "*",
    urlPath: "*",
    version: 1,
  });
}

// Alerting plane dispatches are traced at 100% (higher priority than the LOB default):
// dispatch volume for one volunteer department is negligible cost, and a post-incident
// review needs the trace to exist (architecture.compiled/spine.md:66 — alerting metrics
// drive P0 alarms that page a human).
export function createAlertingSamplingRule(env: string): aws.xray.SamplingRule {
  requireEnv("createAlertingSamplingRule", env);

  return new aws.xray.SamplingRule(`boxalarm-${env}-alerting-sampling`, {
    ruleName: `boxalarm-${env}-alerting-sampling`,
    priority: 100,
    fixedRate: 1.0,
    reservoirSize: 1,
    resourceArn: "*",
    serviceType: "*",
    // X-Ray matches serviceName against the segment name, which for a Lambda is the
    // function name (boxalarm-{env}-alerting-service-{route} under Lambda-per-route).
    // The wildcard is required, but for Lambda the initial sampling decision is made
    // by the Lambda service, so this custom rule does not govern every segment it
    // emits — 100% is not guaranteed until verified against real functions.
    serviceName: `boxalarm-${env}-alerting-service-*`,
    host: "*",
    httpMethod: "*",
    urlPath: "*",
    version: 1,
  });
}
