/**
 * RFC 4122 version-4 UUID. Uses crypto.getRandomValues when the runtime provides it (Hermes with
 * a polyfill, Jest) and Math.random otherwise - these ids only need to be unique per answer, not
 * unguessable. Always matches the alerting service's clientAnswerId pattern
 * ^[A-Za-z0-9._:-]{1,128}$.
 */
export function uuidV4(): string {
  const bytes = new Uint8Array(16);
  const cryptoApi = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } })
    .crypto;
  if (cryptoApi?.getRandomValues) {
    cryptoApi.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
