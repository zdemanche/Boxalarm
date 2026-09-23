import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { Config, getStack } from "@pulumi/pulumi";
import { ServiceLogGroup, serviceLogGroupName } from "./components/observability/service-log-group";
import { ServiceDashboard } from "./components/observability/service-dashboard";
import {
  createDefaultSamplingRule,
  createAlertingSamplingRule,
} from "./components/observability/xray-sampling";
import { SERVICES, ServiceName } from "./components/observability/services";
import { BoxalarmUserPool } from "./components/identity/user-pool";
import { BoxalarmUserPoolClient } from "./components/identity/user-pool-client";
import { HttpApi } from "./components/api/http-api";
import { PlatformTable } from "./components/data/platform-table";
import { IncidentTable } from "./components/data/incident-table";
import { AlertingTable } from "./components/data/alerting-table";
import { AuditTrail } from "./components/data/audit-trail";
import { NerisConfig } from "./components/neris/neris-config";
import { AlertingPlaneBoundary } from "./components/alerting/iam-boundary";
import { MessagingAlerting } from "./components/alerting/messaging-alerting";
import { Escalation } from "./components/alerting/escalation";
import { FanOut } from "./components/alerting/fan-out";
import { ChannelWorkers } from "./components/alerting/channel-workers";
import { RoutesCore } from "./components/alerting/routes-core";
import { RoutesOps } from "./components/alerting/routes-ops";
import { PushTokens } from "./components/alerting/push-tokens";
import { RidingBoard } from "./components/alerting/riding-board";
import { AlertingAlarms } from "./components/alerting/alarms";
import { EligibilityStaleness } from "./components/alerting/staleness";

export const stack = getStack();
const config = new Config("boxalarm-infra");
export const env = config.require("env");
export const webOrigin = config.require("webOrigin");

// #180 / #6: base identity + pre-token-generation trigger that puts
// custom:deptId on the ACCESS token for the shared authorizer.
export const identity = new BoxalarmUserPool("identity", { env });
export const userPoolId = identity.userPool.id;

const SELF_SERVICE_WRITE_ATTRIBUTES = ["email", "name", "phone_number"] as const;

export const mobileUserPoolClient = new BoxalarmUserPoolClient("identity-client-mobile", {
  userPoolId: identity.userPool.id,
  clientName: `boxalarm-${env}-mobile`,
  standardWriteAttributes: SELF_SERVICE_WRITE_ATTRIBUTES,
  callbackUrls: ["boxalarm://auth"],
  logoutUrls: ["boxalarm://auth"],
});

export const webUserPoolClient = new BoxalarmUserPoolClient("identity-client-web", {
  userPoolId: identity.userPool.id,
  clientName: `boxalarm-${env}-web`,
  standardWriteAttributes: SELF_SERVICE_WRITE_ATTRIBUTES,
  // silent-renew.html is required for the iframe fallback path (#6 comment).
  callbackUrls: [`${webOrigin}/auth/callback`, `${webOrigin}/silent-renew.html`],
  logoutUrls: [webOrigin],
});

const region = aws.getRegionOutput();
export const cognitoIssuer = pulumi.interpolate`https://cognito-idp.${region.name}.amazonaws.com/${identity.userPool.id}`;

export const defaultSamplingRule = createDefaultSamplingRule(env);
export const alertingSamplingRule = createAlertingSamplingRule(env);

export const serviceLogGroups = SERVICES.map(
  (serviceName) => new ServiceLogGroup(`${serviceName}-log-group`, { env, serviceName }),
);

export const serviceLogGroupNames = Object.fromEntries(
  SERVICES.map((s) => [s, serviceLogGroupName(env, s)]),
);

// Name-keyed, not positional: SERVICES.indexOf("platform-service") returning -1 on a
// rename/reorder would silently yield undefined here with no compile-time signal.
const serviceLogGroupByName = Object.fromEntries(
  SERVICES.map((s, i) => [s, serviceLogGroups[i]]),
) as Record<ServiceName, ServiceLogGroup>;
const platformLogGroup = serviceLogGroupByName["platform-service"];
const alertingLogGroup = serviceLogGroupByName["alerting-service"];
const personnelLogGroup = serviceLogGroupByName["personnel-service"];
const apparatusLogGroup = serviceLogGroupByName["apparatus-service"];

export const serviceDashboards = SERVICES.map(
  (serviceName) => new ServiceDashboard(`${serviceName}-dashboard`, { env, serviceName }),
);

// E8-S1-INFRA #6 residual: shared HTTP API + authorizer (consumes ServiceLambda / #88).
export const httpApi = new HttpApi("http-api", {
  env,
  userPoolId: identity.userPool.id,
  allowedClientIds: [webUserPoolClient.userPoolClient.id, mobileUserPoolClient.userPoolClient.id],
  platformLogGroup,
});

// Shared data plane tables (ownership: #84 platform, #62 incident, #48 alerting).
export const platformTable = new PlatformTable("platform", { env });
export const incidentTable = new IncidentTable("incident", { env });
export const alertingTable = new AlertingTable("alerting", { env });

// E8-S5-INFRA #84: CloudTrail data events on alerting table + Object Lock archive.
export const auditTrail = new AuditTrail("audit-trail", {
  env,
  alertingTableArn: alertingTable.table.arn,
});

// E6-S7-INFRA #68: NERIS per-env secret + SSM (values out-of-band).
export const nerisConfig = new NerisConfig("neris", { env });

export const deptId = config.require("deptId");

// E1-S13-INFRA #38: alerting isolation as an enforced IAM boundary, attached to every
// alerting-service role below.
export const alertingPlaneBoundary = new AlertingPlaneBoundary("alerting-plane-boundary", {
  env,
  platformTableArn: platformTable.tableArn,
  platformStreamArn: platformTable.streamArn,
  incidentTableArn: incidentTable.tableArn,
  incidentStreamArn: incidentTable.streamArn,
});
const alertingBoundaryArn = alertingPlaneBoundary.policy.arn;

// E1-S2/S3-INFRA #28/#29: alerting messaging plane — SNS FIFO topic + per-channel SQS
// FIFO queues/DLQs. Shares no resource with the LOB bus.
export const messagingAlerting = new MessagingAlerting("messaging-alerting", { env });

export const escalation = new Escalation("escalation", {
  env,
  alertingTableArn: alertingTable.tableArn,
  alertingTopicArn: messagingAlerting.topic.arn,
  alertingTableName: alertingTable.tableName,
  logGroup: alertingLogGroup,
  permissionsBoundaryArn: alertingBoundaryArn,
});

export const fanOut = new FanOut("fan-out", {
  env,
  alertingTableArn: alertingTable.tableArn,
  alertingTableName: alertingTable.tableName,
  alertingStreamArn: alertingTable.streamArn,
  alertingTopicArn: messagingAlerting.topic.arn,
  escalation,
  logGroup: alertingLogGroup,
  permissionsBoundaryArn: alertingBoundaryArn,
});

export const channelWorkers = new ChannelWorkers("channel-workers", {
  env,
  alertingTableArn: alertingTable.tableArn,
  alertingTableName: alertingTable.tableName,
  channelQueues: messagingAlerting.channelQueues,
  logGroup: alertingLogGroup,
  permissionsBoundaryArn: alertingBoundaryArn,
});

// E1-S1/S5/S6-INFRA: manual dispatch ingress, response confirmation, roster, detail.
export const routesCore = new RoutesCore("routes-core", {
  env,
  httpApi,
  alertingTableArn: alertingTable.tableArn,
  alertingTableName: alertingTable.tableName,
  logGroup: alertingLogGroup,
  permissionsBoundaryArn: alertingBoundaryArn,
});

// E1-S4/S8/S9-INFRA: self-test, audit, and provider delivery-receipt routes.
export const routesOps = new RoutesOps("routes-ops", {
  env,
  httpApi,
  alertingTableArn: alertingTable.tableArn,
  alertingTableName: alertingTable.tableName,
  logGroup: alertingLogGroup,
  permissionsBoundaryArn: alertingBoundaryArn,
});

// E1-S14-INFRA #39: push-token routes (platform table) + member-updated consumer
// (alerting table only).
export const pushTokens = new PushTokens("push-tokens", {
  env,
  httpApi,
  platformTableArn: platformTable.tableArn,
  platformTableName: platformTable.tableName,
  alertingTableArn: alertingTable.tableArn,
  alertingTableName: alertingTable.tableName,
  personnelLogGroup,
  alertingLogGroup,
  alertingPermissionsBoundaryArn: alertingBoundaryArn,
});

// E1-S18-INFRA #111 (partial — see riding-board.ts for the deviation from the ticket).
export const ridingBoard = new RidingBoard("riding-board", {
  env,
  httpApi,
  platformTableArn: platformTable.tableArn,
  platformTableName: platformTable.tableName,
  logGroup: apparatusLogGroup,
});

// E1-S11-INFRA #36: alerting-page topic, DLQ/failure alarms, non-prod fault injection.
export const alertingAlarms = new AlertingAlarms("alerting-alarms", {
  env,
  channelQueues: messagingAlerting.channelQueues,
});

// E1-S13-INFRA #38: eligibility-snapshot staleness schedule + alarm.
export const eligibilityStaleness = new EligibilityStaleness("eligibility-staleness", {
  env,
  deptId,
  alertingTableArn: alertingTable.tableArn,
  alertingTableName: alertingTable.tableName,
  pageTopicArn: alertingAlarms.pageTopic.arn,
  logGroup: alertingLogGroup,
  permissionsBoundaryArn: alertingBoundaryArn,
});

// Stack outputs for boxalarm-ui / later children.
export const COGNITO_ISSUER = cognitoIssuer;
export const COGNITO_WEB_CLIENT_ID = webUserPoolClient.userPoolClient.id;
export const COGNITO_NATIVE_CLIENT_ID = mobileUserPoolClient.userPoolClient.id;
export const HTTP_API_ENDPOINT = httpApi.apiEndpoint;
export const PLATFORM_TABLE_NAME = platformTable.tableName;
export const INCIDENT_TABLE_NAME = incidentTable.tableName;
export const ALERTING_TABLE_NAME = alertingTable.tableName;
