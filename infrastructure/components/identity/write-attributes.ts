// Cognito defaults custom attributes to writable by app clients (unlike standard
// attributes, there is no separate "admin only" flag) — see #180 and
// boxalarm-backend's tokenVerifier.ts. Any UserPoolClient's writeAttributes must be
// built through this function, never assembled ad hoc, so a client can never end up
// with self-service write access to a department-scoping or other custom attribute.
export function clientWriteAttributes(standardAttributes: readonly string[]): string[] {
  const custom = standardAttributes.filter((attr) => attr.startsWith("custom:"));
  if (custom.length > 0) {
    throw new Error(
      `clientWriteAttributes: custom attributes are never self-service writable (received ${custom.join(", ")})`,
    );
  }
  return [...standardAttributes];
}
