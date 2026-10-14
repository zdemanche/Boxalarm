export function reportClientError(error: unknown, context: Record<string, unknown> = {}): void {
  console.error(
    JSON.stringify({
      level: 'error',
      source: 'web',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      ...context,
    }),
  );
}
