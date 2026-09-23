import { ServiceName } from "./services";

export interface IamPolicyStatement {
  Sid: string;
  Effect: "Allow" | "Deny";
  Action: string[];
  Resource: string | string[];
  Condition?: Record<string, Record<string, string[]>>;
}

// Cross-repo literal: the backend logger for a service MUST emit CloudWatch custom
// metrics under this exact namespace — alerting isolation is an IAM boundary
// (CLAUDE.md), so a LOB service role must be unable to write into the alerting
// namespace even though PutMetricData has no ARN-level resource scoping.
export function metricsNamespaceFor(serviceName: ServiceName): string {
  return `Boxalarm/${serviceName}`;
}

export function observabilityPolicyStatements(
  logGroupArn: string,
  serviceName: ServiceName,
): IamPolicyStatement[] {
  if (typeof logGroupArn !== "string" || logGroupArn.length === 0) {
    throw new Error(
      `observabilityPolicyStatements: logGroupArn is required (received ${JSON.stringify(logGroupArn)})`,
    );
  }

  return [
    {
      Sid: "WriteOwnLogGroup",
      Effect: "Allow",
      Action: ["logs:CreateLogStream", "logs:PutLogEvents"],
      Resource: `${logGroupArn}:*`,
    },
    {
      // xray:PutTraceSegments/PutTelemetryRecords genuinely have no ARN-level
      // scoping — this wildcard is AWS-mandated, not scopable like PutMetricData.
      Sid: "XRayWrite",
      Effect: "Allow",
      Action: ["xray:PutTraceSegments", "xray:PutTelemetryRecords"],
      Resource: "*",
    },
    {
      Sid: "CloudWatchMetrics",
      Effect: "Allow",
      Action: ["cloudwatch:PutMetricData"],
      Resource: "*",
      Condition: {
        StringEquals: { "cloudwatch:namespace": [metricsNamespaceFor(serviceName)] },
      },
    },
  ];
}
