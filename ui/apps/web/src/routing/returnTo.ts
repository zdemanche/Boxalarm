export function safeReturnPath(value: unknown): string {
  if (typeof value !== 'string') return '/';
  return value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : '/';
}
