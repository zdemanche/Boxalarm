export function logStructuredError(
  event: string,
  correlationId: string,
  context: Record<string, unknown> = {},
): void {
  console.error(JSON.stringify({ event, correlationId, ...context }));
}
