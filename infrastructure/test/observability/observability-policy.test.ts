import { describe, expect, it } from "vitest";
import {
  observabilityPolicyStatements,
  metricsNamespaceFor,
} from "../../components/observability/observability-policy";

describe("observabilityPolicyStatements", () => {
  it("scopes log-write actions to the service's own log group", () => {
    const statements = observabilityPolicyStatements(
      "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/boxalarm-prod-alerting-service",
      "alerting-service",
    );
    const logStatement = statements.find((s) => s.Sid === "WriteOwnLogGroup");
    expect(logStatement?.Action).toEqual(["logs:CreateLogStream", "logs:PutLogEvents"]);
    expect(logStatement?.Resource).toBe(
      "arn:aws:logs:us-east-1:123456789012:log-group:/aws/lambda/boxalarm-prod-alerting-service:*",
    );
  });

  it("uses the AWS-mandated wildcard resource for X-Ray, which has no ARN-level scoping", () => {
    const statements = observabilityPolicyStatements(
      "arn:aws:logs:us-east-1:123456789012:log-group:x",
      "alerting-service",
    );
    const xrayStatement = statements.find((s) => s.Sid === "XRayWrite");
    expect(xrayStatement?.Action).toEqual(["xray:PutTraceSegments", "xray:PutTelemetryRecords"]);
    expect(xrayStatement?.Resource).toBe("*");
  });

  it("scopes PutMetricData to the service's own metrics namespace so no service role can write into another service's namespace", () => {
    const alertingStatements = observabilityPolicyStatements(
      "arn:aws:logs:us-east-1:123456789012:log-group:x",
      "alerting-service",
    );
    const metricsStatement = alertingStatements.find((s) => s.Sid === "CloudWatchMetrics");
    expect(metricsStatement?.Action).toEqual(["cloudwatch:PutMetricData"]);
    expect(metricsStatement?.Resource).toBe("*");
    expect(metricsStatement?.Condition).toEqual({
      StringEquals: { "cloudwatch:namespace": ["Boxalarm/alerting-service"] },
    });

    const platformStatements = observabilityPolicyStatements(
      "arn:aws:logs:us-east-1:123456789012:log-group:x",
      "platform-service",
    );
    const platformMetricsStatement = platformStatements.find((s) => s.Sid === "CloudWatchMetrics");
    expect(platformMetricsStatement?.Condition?.StringEquals["cloudwatch:namespace"]).toEqual([
      "Boxalarm/platform-service",
    ]);
    expect(platformMetricsStatement?.Condition?.StringEquals["cloudwatch:namespace"]).not.toEqual(
      metricsStatement?.Condition?.StringEquals["cloudwatch:namespace"],
    );
  });

  it("never emits a permission naming another service's table", () => {
    const statements = observabilityPolicyStatements(
      "arn:aws:logs:us-east-1:123456789012:log-group:x",
      "alerting-service",
    );
    const serialized = JSON.stringify(statements);
    expect(serialized).not.toContain("platform-service-table");
    expect(serialized).not.toContain("incident-service-table");
  });

  it("throws rather than emitting an unscoped logs:* fallback on empty logGroupArn", () => {
    expect(() => observabilityPolicyStatements("", "alerting-service")).toThrow(
      /logGroupArn is required/,
    );
  });
});

describe("metricsNamespaceFor", () => {
  it("derives the cross-repo namespace literal from the service name", () => {
    expect(metricsNamespaceFor("alerting-service")).toBe("Boxalarm/alerting-service");
    expect(metricsNamespaceFor("personnel-service")).toBe("Boxalarm/personnel-service");
  });
});
