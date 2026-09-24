export type StatusRole = 'ok' | 'alarm' | 'warn' | 'info' | 'neutral';

const ROLE_COLOR_VAR: Record<StatusRole, string> = {
  ok: 'var(--boxalarm-success)',
  alarm: 'var(--boxalarm-error)',
  warn: 'var(--boxalarm-warning)',
  info: 'var(--boxalarm-accent)',
  neutral: 'var(--boxalarm-fg)',
};

const ROLE_GLYPH: Record<StatusRole, string> = {
  ok: '●',
  alarm: '✕',
  warn: '◐',
  info: '▲',
  neutral: '–',
};

/** Status = colour + glyph + word together, never colour alone (N7.1). */
export function StatusBadge({ role, word }: { role: StatusRole; word: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--boxalarm-spacing-xs)',
        color: ROLE_COLOR_VAR[role],
        fontWeight: 600,
      }}
    >
      <span aria-hidden="true">{ROLE_GLYPH[role]}</span>
      <span>{word}</span>
    </span>
  );
}

export function serviceStatusRole(status: 'IN_SERVICE' | 'OUT_OF_SERVICE'): StatusRole {
  return status === 'IN_SERVICE' ? 'ok' : 'alarm';
}
