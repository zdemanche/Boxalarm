/**
 * The incident service's compiled NERIS grammar (backend `neris/apiSchema.ts` SchemaNode), as
 * served per module by GET incidents/neris-schema. The module editor renders from these nodes
 * and the server validates PUT incidents/{id}/modules/{module} against the same ones.
 */
export type SchemaNode =
  | { k: 'obj'; p: Record<string, SchemaNode>; r: string[] }
  | { k: 'arr'; i: SchemaNode }
  | { k: 'enum'; v: string[] }
  | { k: 'const'; v: string | number | boolean }
  | { k: 'str' | 'num' | 'int' | 'bool' | 'any' }
  | { k: 'ref'; n: string }
  | { k: 'union'; o: SchemaNode[]; d?: string };

export type Defs = Readonly<Record<string, unknown>>;
export type JsonRecord = Record<string, unknown>;

const ANY: SchemaNode = { k: 'any' };

export function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

/** Follows `ref`s through `defs`; anything unrecognised (untrusted JSON) becomes `any`. */
export function resolveNode(defs: Defs, node: unknown): SchemaNode {
  let current = asRecord(node);
  for (let depth = 0; current?.k === 'ref' && depth < 20; depth++) {
    current = asRecord(defs[String(current.n)]);
  }
  return current && typeof current.k === 'string' && current.k !== 'ref'
    ? (current as SchemaNode)
    : ANY;
}

/** The values a union option's discriminator accepts (a const, or each value of an enum). */
function tagsOf(defs: Defs, option: SchemaNode, key: string): string[] {
  const resolved = resolveNode(defs, option);
  if (resolved.k !== 'obj' || !resolved.p[key]) return [];
  const field = resolveNode(defs, resolved.p[key]);
  if (field.k === 'const') return [String(field.v)];
  return field.k === 'enum' ? field.v : [];
}

export interface UnionChoice {
  tag: string;
  option: Extract<SchemaNode, { k: 'obj' }>;
}

/** Every discriminator value of a union, with the object option it selects. */
export function unionChoices(defs: Defs, union: Extract<SchemaNode, { k: 'union' }>) {
  const key = union.d ?? 'type';
  return union.o.flatMap((option) => {
    const resolved = resolveNode(defs, option);
    if (resolved.k !== 'obj') return [];
    return tagsOf(defs, option, key).map((tag): UnionChoice => ({ tag, option: resolved }));
  });
}

/** `UPPER_SNAKE` / `snake_case` -> "Upper snake". */
export function humanize(value: string): string {
  const words = value.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "presence.alarm_types[0]" -> "Presence › Alarm types 1" for error summaries. */
export function humanizePath(path: string): string {
  return path
    .split('.')
    .map((part) =>
      humanize(part.replace(/\[(\d+)\]/g, (_match, index: string) => ` ${Number(index) + 1}`)),
    )
    .join(' › ');
}

/** DOM id of the control for `path` inside a module editor (the first input of a group). */
export function controlId(module: string, path: string): string {
  return `module-${module}-${path.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

/**
 * The value reduced to what the officer entered: empty strings, unset choices, empty lists and
 * empty objects are omitted, and union fields left over from another branch are dropped.
 */
export function pruneValue(defs: Defs, node: unknown, value: unknown): unknown {
  if (value === undefined || value === null || value === '') return undefined;
  const resolved = resolveNode(defs, node);
  if (resolved.k === 'obj') {
    const record = asRecord(value);
    if (!record) return undefined;
    const out: JsonRecord = {};
    for (const [key, child] of Object.entries(resolved.p)) {
      const picked = pruneValue(defs, child, record[key]);
      if (picked !== undefined) out[key] = picked;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  if (resolved.k === 'arr') {
    if (!Array.isArray(value)) return undefined;
    const items = value
      .map((item) => pruneValue(defs, resolved.i, item))
      .filter((item) => item !== undefined);
    return items.length > 0 ? items : undefined;
  }
  if (resolved.k === 'union') {
    const tag = asRecord(value)?.[resolved.d ?? 'type'];
    const choice = unionChoices(defs, resolved).find((item) => item.tag === tag);
    return choice ? pruneValue(defs, choice.option, value) : undefined;
  }
  return value;
}

/** The NERIS modules the incident page edits (incident-service getNerisSchema EDITABLE_MODULES). */
export const EDITABLE_MODULES = [
  'smoke_alarm',
  'fire_alarm',
  'other_alarm',
  'fire_suppression',
  'cooking_fire_suppression',
] as const;

/**
 * Which module editors the report shows: the four a structure fire requires (plus cooking
 * suppression for a cooking fire), the same rule as incident-service nerisValidation, and any
 * module that already holds a value so nothing entered is hidden.
 */
export function modulesForIncident(
  incidentType: string,
  corePayload: Readonly<Record<string, unknown>>,
): { module: string; required: boolean }[] {
  const structureFire = incidentType.includes('STRUCTURE_FIRE');
  const cooking = structureFire && incidentType.includes('COOKING');
  return EDITABLE_MODULES.flatMap((module) => {
    const required = structureFire && (module !== 'cooking_fire_suppression' || cooking);
    const stored = corePayload[module] !== undefined && corePayload[module] !== null;
    return required || stored ? [{ module, required }] : [];
  });
}
