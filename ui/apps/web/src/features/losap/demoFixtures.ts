function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function tryHandleLosapExtras(
  parts: string[],
  method: string,
  body: Record<string, unknown>,
): Response | undefined {
  if (
    parts[0] === 'personnel' &&
    parts[1] === 'losap' &&
    parts[2] === 'rules' &&
    method === 'PUT'
  ) {
    return json({
      ruleVersionId: `v-${Date.now()}`,
      pointsByActivityType: body.pointsByActivityType,
    });
  }
  return undefined;
}
