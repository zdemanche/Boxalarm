import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { Config, getStack } from "@pulumi/pulumi";
import { ServiceLogGroup, serviceLogGroupName } from "./components/observability/service-log-group";
import { ServiceDashboard } from "./components/observability/service-dashboard";
import {
  createDefaultSamplingRule,
  createAlertingSamplingRule,
} from "./components/observability/xray-sampling";
import { SERVICES } from "./components/observability/services";
import { BoxalarmUserPool } from "./components/identity/user-pool";
import { BoxalarmUserPoolClient } from "./components/identity/user-pool-client";
import { HttpApi } from "./components/api/http-api";
import { PlatformTable } from "./components/data/platform-table";
import { IncidentTable } from "./components/data/incident-table";
import { AlertingTable } from "./components/data/alerting-table";
import { AuditTrail } from "./components/data/audit-trail";
import { NerisConfig } from "./components/neris/neris-config";

export const stack = getStack();
const config = new Config("boxalarm-infra");
export const env = config.require("env");
export const webOrigin = config.require("webOrigin");

// boxalarm-docs#115 / #6: base identity + pre-token-generation trigger that puts
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

const platformLogGroupIndex = SERVICES.indexOf("platform-service");
const platformLogGroup = serviceLogGroups[platformLogGroupIndex];

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

// Stack outputs for boxalarm-ui / later children.
export const COGNITO_ISSUER = cognitoIssuer;
export const COGNITO_WEB_CLIENT_ID = webUserPoolClient.userPoolClient.id;
export const COGNITO_NATIVE_CLIENT_ID = mobileUserPoolClient.userPoolClient.id;
export const HTTP_API_ENDPOINT = httpApi.apiEndpoint;
export const PLATFORM_TABLE_NAME = platformTable.tableName;
export const INCIDENT_TABLE_NAME = incidentTable.tableName;
export const ALERTING_TABLE_NAME = alertingTable.tableName;
