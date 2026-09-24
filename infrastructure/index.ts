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
import { PolicyStore } from "./components/authz/policy-store";
import { PlatformBus } from "./components/messaging/platform-bus";
import { OutboxPublisher } from "./components/messaging/outbox-publisher";
import { SessionRevocation } from "./components/identity/session-revocation";
import { RecoveryMonitor } from "./components/identity/recovery-monitor";
import { Members } from "./components/personnel/members";
import { Config as PlatformConfig } from "./components/platform/config";
import { AuditRoute } from "./components/platform/audit-route";
import { Export } from "./components/platform/export";
import { Retention } from "./components/platform/retention";
import { ChiefNotificationTopic } from "./components/shared/chief-notifications";

export const stack = getStack();
const config = new Config("boxalarm-infra");
export const env = config.require("env");
export const webOrigin = config.require("webOrigin");

// #180 / #6: base identity + pre-token-generation trigger that puts
// custom:deptId on the ACCESS token for the shared authorizer.
export const identity = new BoxalarmUserPool("identity", { env });
export const userPoolId = identity.userPool.id;

const SELF_SERVICE_WRITE_ATTRIBUTES = ["email", "name", "phone_number"] as const;

// E8-S8-INFRA #259: identical token policy on both clients — sign in once and
// forget (CLAUDE.md); revocation is the only control that ends a session.
const SESSION_TOKEN_POLICY = {
  enableTokenRevocation: true,
  accessTokenValidityHours: 1,
  idTokenValidityHours: 1,
  refreshTokenValidityDays: 3650,
  refreshTokenRotationGraceSeconds: 60,
} as const;

export const mobileUserPoolClient = new BoxalarmUserPoolClient("identity-client-mobile", {
  userPoolId: identity.userPool.id,
  clientName: `boxalarm-${env}-mobile`,
  standardWriteAttributes: SELF_SERVICE_WRITE_ATTRIBUTES,
  callbackUrls: ["boxalarm://auth"],
  logoutUrls: ["boxalarm://auth"],
  ...SESSION_TOKEN_POLICY,
});

export const webUserPoolClient = new BoxalarmUserPoolClient("identity-client-web", {
  userPoolId: identity.userPool.id,
  clientName: `boxalarm-${env}-web`,
  standardWriteAttributes: SELF_SERVICE_WRITE_ATTRIBUTES,
  // silent-renew.html is required for the iframe fallback path (#6 comment).
  callbackUrls: [`${webOrigin}/auth/callback`, `${webOrigin}/silent-renew.html`],
  logoutUrls: [webOrigin],
  ...SESSION_TOKEN_POLICY,
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
const personnelLogGroup = serviceLogGroupByName["personnel-service"];

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

// E8-S3-INFRA #255: shared Verified Permissions policy store.
export const policyStore = new PolicyStore("policy-store", {
  env,
  userPoolId: identity.userPool.id,
  userPoolArn: identity.userPool.arn,
  allowedClientIds: [webUserPoolClient.userPoolClient.id, mobileUserPoolClient.userPoolClient.id],
});

// E8-S8-INFRA #259: shared LOB EventBridge bus.
export const platformBus = new PlatformBus("platform-bus", { env });

// E2-S1-INFRA #203: the ONE platform-table outbox → platform-bus publisher.
export const outboxPublisher = new OutboxPublisher("outbox-publisher", {
  env,
  platformTableName: platformTable.tableName,
  platformTableStreamArn: platformTable.streamArn,
  busName: platformBus.busName,
  busArn: platformBus.busArn,
  logGroup: platformLogGroup,
});

export const sessionRevocation = new SessionRevocation("session-revocation", {
  env,
  userPoolId: identity.userPool.id,
  userPoolArn: identity.userPool.arn,
  policyStoreArn: policyStore.policyStoreArn,
  policyStoreId: policyStore.policyStoreId,
  platformLogGroup,
  httpApi,
  platformBus,
});

export const recoveryMonitor = new RecoveryMonitor("recovery-monitor", {
  env,
  logGroup: platformLogGroup,
});

export const personnelMembers = new Members("personnel-members", {
  env,
  platformTableName: platformTable.tableName,
  platformTableArn: platformTable.tableArn,
  policyStoreArn: policyStore.policyStoreArn,
  policyStoreId: policyStore.policyStoreId,
  logGroup: personnelLogGroup,
  httpApi,
});

export const platformConfig = new PlatformConfig("platform-config", {
  env,
  platformTableName: platformTable.tableName,
  platformTableArn: platformTable.tableArn,
  policyStoreArn: policyStore.policyStoreArn,
  policyStoreId: policyStore.policyStoreId,
  logGroup: platformLogGroup,
  httpApi,
});

export const auditRoute = new AuditRoute("audit-route", {
  env,
  platformTableName: platformTable.tableName,
  platformTableArn: platformTable.tableArn,
  logGroup: platformLogGroup,
  httpApi,
});

export const chiefNotificationTopic = new ChiefNotificationTopic("chief-notifications", { env });

export const platformExport = new Export("platform-export", {
  env,
  platformTableName: platformTable.tableName,
  platformTableArn: platformTable.tableArn,
  incidentTableName: incidentTable.tableName,
  incidentTableArn: incidentTable.tableArn,
  alertingTableName: alertingTable.tableName,
  alertingTableArn: alertingTable.tableArn,
  alertingCmkArn: alertingTable.cmkArn,
  incidentCmkArn: incidentTable.cmkArn,
  chiefNotificationTopicArn: chiefNotificationTopic.topicArn,
  logGroup: platformLogGroup,
  httpApi,
});

export const platformRetention = new Retention("platform-retention", {
  env,
  platformTableName: platformTable.tableName,
  platformTableArn: platformTable.tableArn,
  policyStoreArn: policyStore.policyStoreArn,
  policyStoreId: policyStore.policyStoreId,
  chiefNotificationTopicArn: chiefNotificationTopic.topicArn,
  logGroup: platformLogGroup,
  httpApi,
});

// Stack outputs for boxalarm-ui / later children.
export const COGNITO_ISSUER = cognitoIssuer;
export const COGNITO_WEB_CLIENT_ID = webUserPoolClient.userPoolClient.id;
export const COGNITO_NATIVE_CLIENT_ID = mobileUserPoolClient.userPoolClient.id;
export const HTTP_API_ENDPOINT = httpApi.apiEndpoint;
export const PLATFORM_TABLE_NAME = platformTable.tableName;
export const INCIDENT_TABLE_NAME = incidentTable.tableName;
export const ALERTING_TABLE_NAME = alertingTable.tableName;
export const VERIFIED_PERMISSIONS_POLICY_STORE_ID = policyStore.policyStoreId;
export const PLATFORM_BUS_NAME = platformBus.busName;
