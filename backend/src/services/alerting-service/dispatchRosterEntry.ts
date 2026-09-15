export type AckStatus = 'NONE' | 'RESPONDING' | 'NOT_RESPONDING' | 'DIRECT_TO_SCENE';

export type RosterEntryItem = Record<'pk' | 'sk', string> & {
  readonly entityType: 'DISPATCH_ROSTER_ENTRY';
  readonly memberId: string;
  readonly quals: readonly string[];
  readonly ackStatus: AckStatus;
  readonly ackAt: number | null;
  readonly eta: number | null;
  readonly assignedApparatusId: string | null;
  readonly lastAnsweredTone: number | null;
};

const ACK_STATUSES: ReadonlySet<string> = new Set([
  'NONE',
  'RESPONDING',
  'NOT_RESPONDING',
  'DIRECT_TO_SCENE',
]);

function isNullableNumber(value: unknown): value is number | null | undefined {
  return value === null || value === undefined || typeof value === 'number';
}

function isNullableString(value: unknown): value is string | null | undefined {
  return value === null || value === undefined || typeof value === 'string';
}

export function parseRosterEntryItem(
  item: Record<string, unknown> | undefined,
): RosterEntryItem | undefined {
  if (!item) {
    return undefined;
  }
  const {
    pk,
    sk,
    entityType,
    memberId,
    quals,
    ackStatus,
    ackAt,
    eta,
    assignedApparatusId,
    lastAnsweredTone,
  } = item;
  if (
    typeof pk !== 'string' ||
    typeof sk !== 'string' ||
    entityType !== 'DISPATCH_ROSTER_ENTRY' ||
    typeof memberId !== 'string' ||
    typeof ackStatus !== 'string' ||
    !ACK_STATUSES.has(ackStatus) ||
    !isNullableNumber(ackAt) ||
    !isNullableNumber(eta) ||
    !isNullableString(assignedApparatusId) ||
    !isNullableNumber(lastAnsweredTone)
  ) {
    throw new Error('DISPATCH_ROSTER_ENTRY item failed shape validation');
  }
  return {
    pk,
    sk,
    entityType,
    memberId,
    quals: Array.isArray(quals) ? (quals as readonly string[]) : [],
    ackStatus: ackStatus as AckStatus,
    ackAt: ackAt ?? null,
    eta: eta ?? null,
    assignedApparatusId: assignedApparatusId ?? null,
    lastAnsweredTone: lastAnsweredTone ?? null,
  };
}
