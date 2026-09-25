/** EventBridge bus the later infra bundle attaches the projection rule to. */
export const REPORTING_PLATFORM_BUS = 'boxalarm-{env}-platform-bus';

/** SQS queue the later infra bundle subscribes to `boxalarm-{env}-platform-bus`. */
export const REPORTING_PROJECTION_QUEUE = 'reporting-projection-queue';

/** Paired DLQ. Infra sets maxReceiveCount between 3 and 5. Alarm goes to standard on-call, never the alerting plane. */
export const REPORTING_PROJECTION_DLQ = 'reporting-projection-dlq';

/** Architecture EVENT_DEDUP consumer name. The partition key is department-scoped. */
export const PROJECTION_CONSUMER_NAME = 'reporting-projections';

export const DEDUP_TTL_SECONDS = 48 * 60 * 60;
