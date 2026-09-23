import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import { SERVICES, ServiceName } from "./services";

const KNOWN_SERVICES = new Set<string>(SERVICES);
const regionOutput = aws.getRegionOutput({}).region;

export interface ServiceDashboardArgs {
  env: string;
  serviceName: ServiceName;
}

function searchExpression(functionNamePrefix: string, metricName: string, stat: string): string {
  return `SEARCH('{AWS/Lambda,FunctionName} MetricName="${metricName}" FunctionName=${functionNamePrefix}', '${stat}', 60)`;
}

export class ServiceDashboard extends pulumi.ComponentResource {
  public readonly dashboard: aws.cloudwatch.Dashboard;

  constructor(name: string, args: ServiceDashboardArgs, opts?: pulumi.ComponentResourceOptions) {
    if (typeof args.env !== "string" || args.env.length === 0) {
      throw new Error(`ServiceDashboard: env is required (received ${JSON.stringify(args.env)})`);
    }
    if (typeof args.serviceName !== "string" || !KNOWN_SERVICES.has(args.serviceName)) {
      throw new Error(`ServiceDashboard: unknown serviceName "${String(args.serviceName)}"`);
    }

    super("boxalarm:observability:ServiceDashboard", name, {}, opts);

    // Lambda-per-route (architecture.compiled/spine.md:15): a service has many route
    // functions, none named "boxalarm-{env}-{serviceName}". Widgets must aggregate over
    // every function whose name starts with this prefix, not a single fixed FunctionName.
    const functionNamePrefix = `boxalarm-${args.env}-${args.serviceName}-`;

    const dashboardBody = pulumi.jsonStringify({
      widgets: [
        {
          type: "metric",
          x: 0,
          y: 0,
          width: 8,
          height: 6,
          properties: {
            title: `${args.serviceName} error rate`,
            view: "timeSeries",
            region: regionOutput,
            metrics: [
              [
                {
                  expression: searchExpression(functionNamePrefix, "Errors", "Sum"),
                  id: "errorsSearch",
                  visible: false,
                },
              ],
              [{ expression: "SUM(errorsSearch)", id: "errors", visible: false }],
              [
                {
                  expression: searchExpression(functionNamePrefix, "Invocations", "Sum"),
                  id: "invocationsSearch",
                  visible: false,
                },
              ],
              [{ expression: "SUM(invocationsSearch)", id: "invocations", visible: false }],
              [
                {
                  expression: "(errors / invocations) * 100",
                  label: "Error rate (%)",
                  id: "errorRate",
                },
              ],
            ],
          },
        },
        {
          type: "metric",
          x: 8,
          y: 0,
          width: 8,
          height: 6,
          properties: {
            title: `${args.serviceName} p99 latency`,
            view: "timeSeries",
            region: regionOutput,
            metrics: [
              [
                {
                  expression: searchExpression(functionNamePrefix, "Duration", "p99"),
                  id: "durationSearch",
                  visible: false,
                },
              ],
              [
                {
                  expression: "AVERAGE(durationSearch)",
                  label: `${args.serviceName} p99 latency`,
                  id: "duration",
                },
              ],
            ],
          },
        },
        {
          type: "metric",
          x: 16,
          y: 0,
          width: 8,
          height: 6,
          properties: {
            title: `${args.serviceName} throughput`,
            view: "timeSeries",
            region: regionOutput,
            metrics: [
              [
                {
                  expression: searchExpression(functionNamePrefix, "Invocations", "Sum"),
                  id: "throughputSearch",
                  visible: false,
                },
              ],
              [
                {
                  expression: "SUM(throughputSearch)",
                  label: `${args.serviceName} throughput`,
                  id: "throughput",
                },
              ],
            ],
          },
        },
      ],
    });

    this.dashboard = new aws.cloudwatch.Dashboard(
      `${name}-dashboard`,
      {
        dashboardName: `boxalarm-${args.env}-${args.serviceName}`,
        dashboardBody,
      },
      { parent: this },
    );

    this.registerOutputs({ dashboard: this.dashboard });
  }
}
