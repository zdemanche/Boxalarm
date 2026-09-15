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

export const stack = getStack();
export const env = new Config("boxalarm-infra").require("env");

// boxalarm-docs#115: base identity infrastructure + the pre-token-generation trigger
// that puts custom:deptId on the ACCESS token, which boxalarm-backend's shared
// authorizer requires on every request.
export const identity = new BoxalarmUserPool("identity", { env });
export const userPoolId = identity.userPool.id;

// Standard, self-service-writable profile attributes only — custom:deptId is
// structurally excluded by BoxalarmUserPoolClient regardless of what's listed here.
const SELF_SERVICE_WRITE_ATTRIBUTES = ["email", "name", "phone_number"] as const;

export const mobileUserPoolClient = new BoxalarmUserPoolClient("identity-client-mobile", {
  userPoolId: identity.userPool.id,
  clientName: `boxalarm-${env}-mobile`,
  standardWriteAttributes: SELF_SERVICE_WRITE_ATTRIBUTES,
});

export const webUserPoolClient = new BoxalarmUserPoolClient("identity-client-web", {
  userPoolId: identity.userPool.id,
  clientName: `boxalarm-${env}-web`,
  standardWriteAttributes: SELF_SERVICE_WRITE_ATTRIBUTES,
});

export const defaultSamplingRule = createDefaultSamplingRule(env);
export const alertingSamplingRule = createAlertingSamplingRule(env);

export const serviceLogGroups = SERVICES.map(
  (serviceName) => new ServiceLogGroup(`${serviceName}-log-group`, { env, serviceName }),
);

export const serviceLogGroupNames = Object.fromEntries(
  SERVICES.map((s) => [s, serviceLogGroupName(env, s)]),
);

export const serviceDashboards = SERVICES.map(
  (serviceName) => new ServiceDashboard(`${serviceName}-dashboard`, { env, serviceName }),
);
