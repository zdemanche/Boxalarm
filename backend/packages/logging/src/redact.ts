// Keys that must never appear in logs (member PII). Case-insensitive; matches
// exact key or dotted suffix (e.g. member.phoneNumber).
const PII_KEY =
  /^(?:.*[.])?(?:name|firstName|lastName|fullName|memberName|displayName|phone|phoneNumber|mobile|mobileNumber|email|emailAddress|address|street|streetAddress|homeAddress|mailingAddress|city|zip|zipCode|postalCode)$/i;

const REDACTED = '[REDACTED]';

export function isPiiKey(key: string): boolean {
  return PII_KEY.test(key);
}

export function redactPii<T>(value: T): T {
  return redactValue(value) as T;
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactValue);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isPiiKey(key) ? REDACTED : redactValue(nested);
    }
    return out;
  }
  return value;
}
