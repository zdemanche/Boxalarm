export const SERVICES = [
  "alerting-service",
  "platform-service",
  "personnel-service",
  "apparatus-service",
  "incident-service",
  "training-service",
  "reporting-service",
  "inspections-service",
  "inventory-service",
  "notification-service",
] as const;

export type ServiceName = (typeof SERVICES)[number];
