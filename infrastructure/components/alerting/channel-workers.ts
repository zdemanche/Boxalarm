import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { requireEnv } from "../shared/env";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import {
  ALERT_PATH_MEMORY_MB,
  ALERTING_CHANNELS,
  AlertingChannel,
  ChannelQueue,
  DEFAULT_WORKER_TIMEOUT_SECONDS,
} from "./messaging-alerting";
import { grantAlertingCmk } from "./alerting-cmk";

/** Channels still on the generic HTTP vendor adapter (channels/httpProviderAdapter.ts). */
export type VendorChannel = Exclude<AlertingChannel, "push">;

// OQ-3 (SMS/voice vendor selection) is open. The endpoint channels/httpProviderAdapter.ts
// POSTs to (the member's target, the dispatch narrative, the Bearer provider secret) is stack
// config: `boxalarm-infra:smsProviderEndpointUrl` / `voiceProviderEndpointUrl`. Unset, the
// worker gets a placeholder on the RFC 2606 reserved `.invalid` TLD, which can never resolve,
// so nothing is ever sent to a domain the project does not control - and every SMS/voice page
// fails, dead-letters and fires `…-sms-dlq-not-empty` / `…-voice-dlq-not-empty`. The workers
// stay deployed and subscribed on purpose: unsubscribing them would make SNS drop those pages
// with no DLQ and no alarm. Preview warns while either is unset (deploy-readiness M5).
//
// Two-vendor rule (architecture §1.3, N1.2): push and SMS fire in parallel at T+0 as two
// independent failure domains - push straight to APNs/FCM, SMS through a third-party vendor -
// with voice as the only escalation tier. The SMS/voice vendor must therefore never be a push
// relay, and until one is configured a stack has ONE failure domain (push) plus radio tone-out.
// Push has no endpoint: it goes to APNs and FCM directly (see PushGatewaySecrets).
export const PROVIDER_ENDPOINT_CONFIG_KEY: Record<VendorChannel, string> = {
  sms: "smsProviderEndpointUrl",
  voice: "voiceProviderEndpointUrl",
};
export const PLACEHOLDER_ENDPOINT_URL: Record<VendorChannel, string> = {
  sms: "https://sms-provider.not-yet-selected.invalid",
  voice: "https://voice-provider.not-yet-selected.invalid",
};

/**
 * Push gateway credentials (architecture §Alerting: "Push uses APNs/FCM directly"). Values are
 * set out-of-band; the push worker (channels/push/pushCredentials.ts) reads them as JSON.
 *
 * APNs (`apns`, `apnsSandbox`) — token-based auth with an Apple .p8 key:
 *   {
 *     "teamId": "ABCDE12345",             // Apple Developer Team ID
 *     "keyId": "KEY1234567",              // APNs auth key ID
 *     "privateKey": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----",
 *     "bundleId": "org.example.boxalarm", // apns-topic
 *     "environment": "production",        // optional; "sandbox" for dev-signed app builds
 *     "interruptionLevel": "critical"     // optional; "time-sensitive" until the Critical
 *   }                                     //   Alerts entitlement (#4) is granted
 *   `time-sensitive` relies on the app's Time Sensitive Notifications capability
 *   (ui/apps/mobile/ios/Boxalarm/Boxalarm.entitlements); `critical` on #4.
 *   Each iOS device registers the APNs environment its build is signed for; the worker uses
 *   `apns` for production devices (the default) and `apnsSandbox` for development-signed ones,
 *   for real pages and self-test/canary pushes alike (a token only works on its own host).
 *   The sandbox secret always targets api.sandbox.push.apple.com and is refused if it
 *   declares "production".
 *
 * FCM (`fcm`, `fcmSandbox`) — the Firebase service-account key JSON exactly as downloaded
 * (project_id, private_key_id, private_key, client_email, ...), for a service account with
 * the Firebase Cloud Messaging API Admin role. FCM's apns block (iOS devices still on a legacy
 * FCM token) takes its interruption level from the APNs secret's `interruptionLevel`; an
 * optional `"apnsInterruptionLevel"` key here is only a fallback for when the APNs secret
 * cannot be read (default "critical"). Sandbox sends are `validate_only`; the sandbox
 * service account must be in the app's own Firebase project (another project gets
 * SENDER_ID_MISMATCH on every self-test).
 *
 * Self-test and canary messages (isTest) ring the member's real device: APNs by the device's
 * environment as above, with a payload labelled TEST; FCM with the FCM sandbox secret,
 * validate_only, failing closed when it is unset. Isolation for a test is its one-member
 * audience, its TEST label and no escalation - not a separate APNs host.
 */
export interface PushGatewaySecrets {
  apns: aws.secretsmanager.Secret;
  apnsSandbox: aws.secretsmanager.Secret;
  fcm: aws.secretsmanager.Secret;
  fcmSandbox: aws.secretsmanager.Secret;
}

/**
 * Reserved concurrency per channel worker. The SQS event source mapping's
 * maximumConcurrency is pinned to the same value: when pollers outrun reserved concurrency
 * the invocations are throttled, and each throttled receive counts toward maxReceiveCount,
 * pushing pages to the DLQ early.
 */
export const WORKER_RESERVED_CONCURRENCY = 5;

export interface ChannelWorkersArgs {
  env: string;
  alertingTableArn: pulumi.Input<string>;
  /** Alerting-table CMK — every role touching the table needs it (alerting-cmk.ts). */
  alertingCmkArn: pulumi.Input<string>;
  alertingTableName: pulumi.Input<string>;
  channelQueues: Record<AlertingChannel, ChannelQueue>;
  logGroup: ServiceLogGroup;
  permissionsBoundaryArn?: pulumi.Input<string>;
  /** Must match the value MessagingAlerting sized the queue visibility timeout from. */
  workerTimeoutSeconds?: number;
}

/**
 * Push/SMS/voice channel worker Lambdas (E1-S2/S3-INFRA). Each has its own queue, DLQ,
 * reserved concurrency and provider secrets — no worker can read another channel's queue
 * or secret (E1-S11-INFRA isolation). SMS/voice get `{CH}_PROVIDER_*` for the generic
 * vendor adapter; push gets the APNs/FCM gateway secrets. Self-test sandbox secrets
 * (E1-S8-INFRA) are provisioned alongside every production secret; the worker selects them
 * for `isTest` messages.
 */
export class ChannelWorkers extends pulumi.ComponentResource {
  public readonly workers: Record<AlertingChannel, ServiceLambda>;
  public readonly providerSecrets: Record<VendorChannel, aws.secretsmanager.Secret>;
  public readonly sandboxSecrets: Record<VendorChannel, aws.secretsmanager.Secret>;
  public readonly pushSecrets: PushGatewaySecrets;
  /** Whether each vendor channel has a real provider endpoint (false: it cannot page). */
  public readonly vendorEndpointConfigured: Record<VendorChannel, boolean>;

  constructor(name: string, args: ChannelWorkersArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("ChannelWorkers", args.env);
    super("boxalarm:alerting:ChannelWorkers", name, {}, opts);
    const { env } = args;

    const config = new pulumi.Config("boxalarm-infra");
    const endpointUrls = {} as Record<VendorChannel, string>;
    const configured = {} as Record<VendorChannel, boolean>;
    for (const channel of Object.keys(PROVIDER_ENDPOINT_CONFIG_KEY) as VendorChannel[]) {
      const url = config.get(PROVIDER_ENDPOINT_CONFIG_KEY[channel]);
      configured[channel] = url !== undefined && url.trim() !== "";
      endpointUrls[channel] = configured[channel] ? url!.trim() : PLACEHOLDER_ENDPOINT_URL[channel];
    }
    this.vendorEndpointConfigured = configured;
    const unconfigured = (Object.keys(configured) as VendorChannel[]).filter((c) => !configured[c]);
    if (unconfigured.length > 0) {
      pulumi.log.warn(
        `ChannelWorkers: no provider endpoint for ${unconfigured.join(" and ")} ` +
          `(boxalarm-infra:${unconfigured.map((c) => PROVIDER_ENDPOINT_CONFIG_KEY[c]).join(", ")}; ` +
          `vendor OQ-3 open). Those workers are deployed against a .invalid placeholder: every ` +
          `${unconfigured.join("/")} page dead-letters and pages alerting-page. Push is this ` +
          `stack's only paging channel, and radio tone-out (N1.9) is the page of record.`,
        this,
      );
    }

    const workers: Partial<Record<AlertingChannel, ServiceLambda>> = {};
    const providerSecrets: Partial<Record<VendorChannel, aws.secretsmanager.Secret>> = {};
    const sandboxSecrets: Partial<Record<VendorChannel, aws.secretsmanager.Secret>> = {};

    const pushSecret = (key: string, description: string) =>
      new aws.secretsmanager.Secret(
        `${name}-push-${key}-secret`,
        { name: `boxalarm-${env}-alerting-push-${key}-credentials`, description },
        { parent: this },
      );
    const pushSecrets: PushGatewaySecrets = {
      apns: pushSecret("apns", "APNs .p8 token-auth key (values set out-of-band)"),
      apnsSandbox: pushSecret(
        "apns-sandbox",
        "APNs credentials for development-signed (Xcode) app builds (sandbox host)",
      ),
      fcm: pushSecret("fcm", "FCM service-account JSON (values set out-of-band)"),
      fcmSandbox: pushSecret(
        "fcm-sandbox",
        "FCM service-account JSON for validate_only self-test/canary (E1-S8)",
      ),
    };

    for (const channel of ALERTING_CHANNELS) {
      const queue = args.channelQueues[channel].queue;
      const credentials =
        channel === "push"
          ? pushWorkerCredentials(pushSecrets)
          : vendorWorkerCredentials(
              this,
              name,
              env,
              channel,
              endpointUrls[channel],
              providerSecrets,
              sandboxSecrets,
            );

      const worker = new ServiceLambda(
        `${name}-${channel}-fn`,
        {
          env,
          serviceName: "alerting-service",
          functionName: `boxalarm-${env}-alerting-${channel}-worker`,
          handler: LAMBDA_HANDLER,
          code: lambdaCode("alerting-service", `${channel}-worker`),
          logGroup: args.logGroup,
          environment: {
            ALERTING_TABLE_NAME: args.alertingTableName,
            ...credentials.environment,
          },
          additionalPolicyStatements: pulumi
            .all([pulumi.all(credentials.secretArns), queue.arn])
            .apply(([secretArns, queueArn]) => [
              {
                // The SQS event source mapping polls as this role; without these,
                // CreateEventSourceMapping is rejected and the channel never drains.
                Sid: "ConsumeOwnChannelQueueOnly",
                Effect: "Allow" as const,
                Action: ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
                Resource: queueArn,
              },
              {
                Sid: "AlertingTableWrite",
                Effect: "Allow" as const,
                Action: ["dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:GetItem"],
                Resource: args.alertingTableArn as string,
              },
              {
                Sid: "OwnProviderSecretOnly",
                Effect: "Allow" as const,
                Action: ["secretsmanager:GetSecretValue"],
                Resource: secretArns,
              },
            ]),
          reservedConcurrentExecutions: WORKER_RESERVED_CONCURRENCY,
          timeout: args.workerTimeoutSeconds ?? DEFAULT_WORKER_TIMEOUT_SECONDS,
          memorySize: ALERT_PATH_MEMORY_MB,
          permissionsBoundaryArn: args.permissionsBoundaryArn,
        },
        { parent: this },
      );

      new aws.lambda.EventSourceMapping(
        `${name}-${channel}-event-source`,
        {
          eventSourceArn: queue.arn,
          functionName: worker.function.name,
          functionResponseTypes: ["ReportBatchItemFailures"],
          scalingConfig: { maximumConcurrency: WORKER_RESERVED_CONCURRENCY },
        },
        { parent: this },
      );

      workers[channel] = worker;
    }

    this.workers = workers as Record<AlertingChannel, ServiceLambda>;
    this.providerSecrets = providerSecrets as Record<VendorChannel, aws.secretsmanager.Secret>;
    this.sandboxSecrets = sandboxSecrets as Record<VendorChannel, aws.secretsmanager.Secret>;
    this.pushSecrets = pushSecrets;

    grantAlertingCmk(
      name,
      Object.fromEntries(ALERTING_CHANNELS.map((channel) => [channel, this.workers[channel].role])),
      args.alertingCmkArn,
      { parent: this },
    );

    this.registerOutputs({ workers: this.workers });
  }
}

interface WorkerCredentials {
  environment: Record<string, pulumi.Input<string>>;
  /** Exactly the secrets this worker may read — nothing else. */
  secretArns: pulumi.Input<string>[];
}

/** Push: APNs + FCM gateway secrets and their sandbox twins; no vendor endpoint. */
function pushWorkerCredentials(secrets: PushGatewaySecrets): WorkerCredentials {
  return {
    environment: {
      APNS_SECRET_ID: secrets.apns.name,
      FCM_SECRET_ID: secrets.fcm.name,
      // APNs: development-signed devices (any message); FCM: self-test/canary (validate_only).
      APNS_SANDBOX_SECRET_ID: secrets.apnsSandbox.name,
      FCM_SANDBOX_SECRET_ID: secrets.fcmSandbox.name,
    },
    secretArns: [
      secrets.apns.arn,
      secrets.apnsSandbox.arn,
      secrets.fcm.arn,
      secrets.fcmSandbox.arn,
    ],
  };
}

function vendorWorkerCredentials(
  parent: pulumi.Resource,
  name: string,
  env: string,
  channel: VendorChannel,
  endpointUrl: string,
  providerSecrets: Partial<Record<VendorChannel, aws.secretsmanager.Secret>>,
  sandboxSecrets: Partial<Record<VendorChannel, aws.secretsmanager.Secret>>,
): WorkerCredentials {
  const providerSecret = new aws.secretsmanager.Secret(
    `${name}-${channel}-secret`,
    {
      name: `boxalarm-${env}-alerting-${channel}-provider-credentials`,
      description: `${channel} provider credentials (values set out-of-band)`,
    },
    { parent },
  );
  const sandboxSecret = new aws.secretsmanager.Secret(
    `${name}-${channel}-sandbox-secret`,
    {
      name: `boxalarm-${env}-alerting-${channel}-provider-sandbox-credentials`,
      description: `${channel} provider sandbox/loopback credentials for self-test (E1-S8)`,
    },
    { parent },
  );
  providerSecrets[channel] = providerSecret;
  sandboxSecrets[channel] = sandboxSecret;
  const channelUpper = channel.toUpperCase();
  return {
    environment: {
      [`${channelUpper}_PROVIDER_ENDPOINT_URL`]: endpointUrl,
      [`${channelUpper}_PROVIDER_SECRET_ID`]: providerSecret.name,
      // Self-test and canary messages (isTest=true) must authenticate with the
      // sandbox/loopback credentials, never the prod ones (architecture §1.3).
      [`${channelUpper}_PROVIDER_SANDBOX_SECRET_ID`]: sandboxSecret.name,
    },
    secretArns: [providerSecret.arn, sandboxSecret.arn],
  };
}
