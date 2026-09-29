import * as pulumi from "@pulumi/pulumi";
import { ServiceLambda } from "../observability/service-lambda";
import { ServiceLogGroup } from "../observability/service-log-group";
import { requireEnv } from "../shared/env";
import { lambdaCode, LAMBDA_HANDLER } from "../shared/lambda-code";
import { dynamoGrant } from "./shared";

export const ALERT_CONTEXT_REPLAY_TIMEOUT_SECONDS = 900;

export interface AlertContextReplayArgs {
  env: string;
  platformTableName: pulumi.Input<string>;
  platformTableArn: pulumi.Input<string>;
  logGroup: ServiceLogGroup;
}

/**
 * The alert-context replay (inspections-service/replay/alertContextReplayHandler.ts): an
 * invoke-only Lambda — no route, no schedule — run by hand after deploy and after an
 * alerting address-normalizer change to re-emit inspections.*.updated for every pre-plan and
 * hydrant. Runbook: docs/runbooks/alert-context-replay.md.
 *
 * LOB plane, platform table only. It reads the department list partitions (GSI3), the
 * pre-plan/occupancy/hydrant rows, and writes OUTBOX_ENTRY rows in a transaction with a
 * ConditionCheck on the source row — no Update/Delete, so it can touch nothing else.
 */
export class AlertContextReplay extends pulumi.ComponentResource {
  public readonly lambda: ServiceLambda;

  constructor(name: string, args: AlertContextReplayArgs, opts?: pulumi.ComponentResourceOptions) {
    requireEnv("AlertContextReplay", args.env);
    super("boxalarm:inspections:AlertContextReplay", name, {}, opts);

    this.lambda = new ServiceLambda(
      `${name}-fn`,
      {
        env: args.env,
        serviceName: "inspections-service",
        functionName: `boxalarm-${args.env}-inspections-alert-context-replay`,
        handler: LAMBDA_HANDLER,
        code: lambdaCode("inspections-service", "alert-context-replay"),
        logGroup: args.logGroup,
        environment: { PLATFORM_TABLE_NAME: args.platformTableName },
        timeout: ALERT_CONTEXT_REPLAY_TIMEOUT_SECONDS,
        // One run at a time: two concurrent replays would only duplicate events.
        reservedConcurrentExecutions: 1,
        additionalPolicyStatements: pulumi
          .output(args.platformTableArn)
          .apply((tableArn) => [
            dynamoGrant(
              "ReplayListQuery",
              ["dynamodb:Query"],
              [tableArn, `${tableArn}/index/GSI3`],
            ),
            dynamoGrant(
              "ReplayReadAndEmit",
              ["dynamodb:GetItem", "dynamodb:ConditionCheckItem", "dynamodb:PutItem"],
              [tableArn],
            ),
          ]),
      },
      { parent: this },
    );

    this.registerOutputs({ lambda: this.lambda });
  }
}
