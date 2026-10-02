/**
 * NERIS payload schema, compiled from the NERIS OpenAPI document that the daily schema
 * refresh downloads (schemaVersion/refreshScanner). It is the single source of truth for:
 *   - the incident types the web picker offers and local validation accepts
 *     (`TypeIncidentValue`);
 *   - what the payload builder may send: every module is deep-picked to its NERIS
 *     sub-schema, so an unknown or nested key never leaves Boxalarm (neris/payload.ts);
 *   - the module editors on the incident page (smoke/fire/other alarm, suppression), which
 *     render from the same nodes the server validates against.
 *
 * The compiled form keeps only structure: object properties and their required list,
 * arrays, enums and consts, scalar kinds, references, and discriminated unions. Titles,
 * descriptions and examples are dropped, so the artifact is small and stable.
 */

export type SchemaNode =
  | {
      readonly k: 'obj';
      readonly p: Readonly<Record<string, SchemaNode>>;
      readonly r: readonly string[];
    }
  | { readonly k: 'arr'; readonly i: SchemaNode }
  | { readonly k: 'enum'; readonly v: readonly string[] }
  | { readonly k: 'const'; readonly v: string | number | boolean }
  | { readonly k: 'str' | 'num' | 'int' | 'bool' | 'any' }
  | { readonly k: 'ref'; readonly n: string }
  | { readonly k: 'union'; readonly o: readonly SchemaNode[]; readonly d?: string };

export interface CompiledNerisSchema {
  /** NERIS API version the document declared (`info.version`), e.g. `1.5.1`. */
  readonly apiVersion: string;
  /** `TypeIncidentValue`: every value NERIS accepts as `incident_types[].type`. */
  readonly incidentTypes: readonly string[];
  /** Named schemas reachable from `IncidentPayload` (plus the payload itself). */
  readonly defs: Readonly<Record<string, SchemaNode>>;
}

export const PAYLOAD_ROOT = 'IncidentPayload';

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : undefined;
}

const REF_PREFIX = '#/components/schemas/';

export function compileNerisSchema(openapi: unknown): CompiledNerisSchema {
  const doc = asRecord(openapi);
  const schemas = asRecord(asRecord(doc?.components)?.schemas);
  const apiVersion = asRecord(doc?.info)?.version;
  if (!schemas || typeof apiVersion !== 'string' || !schemas[PAYLOAD_ROOT]) {
    throw new Error('NERIS OpenAPI document failed shape validation');
  }
  const incidentTypes = asRecord(schemas.TypeIncidentValue)?.enum;
  if (!Array.isArray(incidentTypes) || incidentTypes.length === 0) {
    throw new Error('NERIS OpenAPI document has no TypeIncidentValue enum');
  }

  const defs: Record<string, SchemaNode> = {};
  const pending: string[] = [PAYLOAD_ROOT];

  const compile = (raw: unknown): SchemaNode => {
    const node = asRecord(raw) ?? {};
    if (typeof node.$ref === 'string') {
      const name = node.$ref.startsWith(REF_PREFIX)
        ? node.$ref.slice(REF_PREFIX.length)
        : node.$ref;
      if (!(name in defs) && !pending.includes(name)) pending.push(name);
      return { k: 'ref', n: name };
    }
    const options = (node.anyOf ?? node.oneOf) as unknown[] | undefined;
    if (Array.isArray(options)) {
      const nonNull = options.filter((o) => asRecord(o)?.type !== 'null');
      if (nonNull.length === 1) return compile(nonNull[0]);
      const discriminator = asRecord(node.discriminator)?.propertyName;
      return {
        k: 'union',
        o: nonNull.map(compile),
        ...(typeof discriminator === 'string' ? { d: discriminator } : {}),
      };
    }
    if (Array.isArray(node.allOf)) {
      return node.allOf.length === 1 ? compile(node.allOf[0]) : { k: 'any' };
    }
    if (node.const !== undefined) {
      return { k: 'const', v: node.const as string | number | boolean };
    }
    if (Array.isArray(node.enum)) {
      return { k: 'enum', v: node.enum.map(String) };
    }
    const properties = asRecord(node.properties);
    if (node.type === 'object' || properties) {
      return {
        k: 'obj',
        p: Object.fromEntries(
          Object.entries(properties ?? {}).map(([key, value]) => [key, compile(value)]),
        ),
        r: Array.isArray(node.required) ? node.required.map(String) : [],
      };
    }
    if (node.type === 'array') return { k: 'arr', i: compile(node.items) };
    if (node.type === 'string') return { k: 'str' };
    if (node.type === 'integer') return { k: 'int' };
    if (node.type === 'number') return { k: 'num' };
    if (node.type === 'boolean') return { k: 'bool' };
    return { k: 'any' };
  };

  while (pending.length > 0) {
    const name = pending.shift()!;
    if (name in defs) continue;
    defs[name] = { k: 'any' };
    defs[name] = compile(schemas[name]);
  }
  return { apiVersion, incidentTypes: incidentTypes.map(String), defs };
}

export function resolveNode(schema: CompiledNerisSchema, node: SchemaNode): SchemaNode {
  let current = node;
  for (let depth = 0; current.k === 'ref' && depth < 20; depth++) {
    current = schema.defs[current.n] ?? { k: 'any' };
  }
  return current;
}

/** The object option of a union that a value selects (by discriminator, else by fit). */
function selectOption(
  schema: CompiledNerisSchema,
  union: Extract<SchemaNode, { k: 'union' }>,
  value: unknown,
): SchemaNode | undefined {
  const record = asRecord(value);
  const options = union.o.map((option) => resolveNode(schema, option));
  if (Array.isArray(value)) {
    const arrays = options.filter((option) => option.k === 'arr');
    return arrays.find((option) => validateNode(schema, option, value).length === 0) ?? arrays[0];
  }
  if (!record) {
    const scalars = options.filter((option) => option.k !== 'obj' && option.k !== 'arr');
    return scalars.find((option) => validateNode(schema, option, value).length === 0) ?? scalars[0];
  }
  const objects = options.filter(
    (option): option is Extract<SchemaNode, { k: 'obj' }> => option.k === 'obj',
  );
  const key = union.d ?? 'type';
  const tag = record[key];
  const byTag = objects.find((option) => {
    const field = option.p[key] ? resolveNode(schema, option.p[key]) : undefined;
    return (
      (field?.k === 'const' && field.v === tag) ||
      (field?.k === 'enum' && field.v.includes(String(tag)))
    );
  });
  return byTag ?? (objects.length === 1 ? objects[0] : undefined);
}

export interface PickOptions {
  /** Keep only the properties the schema marks required, at every level below this node. */
  readonly requiredOnly?: boolean;
  /** Property names never kept at any depth, whatever the schema says. */
  readonly denyKeys?: ReadonlySet<string>;
  /**
   * With `requiredOnly`: below a property with one of these names, optional coded values
   * (enum/const, or arrays of them) are kept too — never free text, numbers or booleans.
   */
  readonly codedValuesUnder?: ReadonlySet<string>;
  /** Internal: set once the walk is below a `codedValuesUnder` property. */
  readonly keepCodedValues?: boolean;
}

/** An enum/const, or an array of them: a coded value, never free text. */
function isCodedNode(schema: CompiledNerisSchema, node: SchemaNode): boolean {
  const resolved = resolveNode(schema, node);
  if (resolved.k === 'enum' || resolved.k === 'const') return true;
  if (resolved.k === 'arr') {
    const item = resolveNode(schema, resolved.i);
    return item.k === 'enum' || item.k === 'const';
  }
  return false;
}

function isStructuredNode(schema: CompiledNerisSchema, node: SchemaNode): boolean {
  const resolved = resolveNode(schema, node);
  return resolved.k === 'obj' || resolved.k === 'union';
}

/**
 * The value reduced to what `node` declares: unknown object keys are dropped at every depth,
 * union branches are chosen by their discriminator, and a value that fits no branch is
 * dropped (undefined). Scalars and enums pass unchanged; `validateNode` reports bad values.
 */
export function deepPick(
  schema: CompiledNerisSchema,
  node: SchemaNode,
  value: unknown,
  options: PickOptions = {},
): unknown {
  if (value === undefined || value === null) return undefined;
  const resolved = resolveNode(schema, node);
  switch (resolved.k) {
    case 'obj': {
      const record = asRecord(value);
      if (!record) return undefined;
      const out: Json = {};
      for (const [key, child] of Object.entries(resolved.p)) {
        if (options.denyKeys?.has(key)) continue;
        const childOptions =
          options.codedValuesUnder?.has(key) && !options.keepCodedValues
            ? { ...options, keepCodedValues: true }
            : options;
        const required = resolved.r.includes(key);
        let optionalKept = false;
        if (options.requiredOnly && !required) {
          if (!childOptions.keepCodedValues) continue;
          if (isCodedNode(schema, child)) optionalKept = true;
          else if (!isStructuredNode(schema, child)) continue;
        }
        const picked = deepPick(schema, child, record[key], childOptions);
        if (picked === undefined) continue;
        // An optional object kept only for its codes is dropped when no code survived.
        const empty = asRecord(picked) !== undefined && Object.keys(picked as object).length === 0;
        if (options.requiredOnly && !required && !optionalKept && empty) continue;
        out[key] = picked;
      }
      return out;
    }
    case 'arr':
      return Array.isArray(value)
        ? value
            .map((item) => deepPick(schema, resolved.i, item, options))
            .filter((item) => item !== undefined)
        : undefined;
    case 'union': {
      const option = selectOption(schema, resolved, value);
      return option ? deepPick(schema, option, value, options) : undefined;
    }
    default:
      return asRecord(value) || Array.isArray(value) ? undefined : value;
  }
}

export interface SchemaIssue {
  readonly path: string;
  readonly code: 'required' | 'enum' | 'type';
  readonly allowed?: readonly string[];
}

/** Required-field, enum/const and scalar-kind problems in `value` against `node`. */
export function validateNode(
  schema: CompiledNerisSchema,
  node: SchemaNode,
  value: unknown,
  path = '',
): SchemaIssue[] {
  const resolved = resolveNode(schema, node);
  const at = (key: string | number) =>
    typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : key;
  switch (resolved.k) {
    case 'obj': {
      const record = asRecord(value);
      if (!record) return [{ path, code: 'type' }];
      const issues: SchemaIssue[] = [];
      for (const key of resolved.r) {
        if (record[key] === undefined || record[key] === null)
          issues.push({ path: at(key), code: 'required' });
      }
      for (const [key, child] of Object.entries(resolved.p)) {
        if (record[key] !== undefined && record[key] !== null) {
          issues.push(...validateNode(schema, child, record[key], at(key)));
        }
      }
      return issues;
    }
    case 'arr':
      return Array.isArray(value)
        ? value.flatMap((item, index) => validateNode(schema, resolved.i, item, at(index)))
        : [{ path, code: 'type' }];
    case 'union': {
      const option = selectOption(schema, resolved, value);
      if (!option) {
        const tags = resolved.o
          .map((o) => resolveNode(schema, o))
          .flatMap((o) => {
            if (o.k !== 'obj') return [];
            const field = o.p[resolved.d ?? 'type'];
            const f = field ? resolveNode(schema, field) : undefined;
            return f?.k === 'const' ? [String(f.v)] : f?.k === 'enum' ? [...f.v] : [];
          });
        return [
          {
            path: path ? `${path}.${resolved.d ?? 'type'}` : (resolved.d ?? 'type'),
            code: 'enum',
            allowed: tags,
          },
        ];
      }
      return validateNode(schema, option, value, path);
    }
    case 'enum':
      return typeof value === 'string' && resolved.v.includes(value)
        ? []
        : [{ path, code: 'enum', allowed: resolved.v }];
    case 'const':
      return value === resolved.v ? [] : [{ path, code: 'enum', allowed: [String(resolved.v)] }];
    case 'str':
      return typeof value === 'string' ? [] : [{ path, code: 'type' }];
    case 'int':
      return Number.isInteger(value) ? [] : [{ path, code: 'type' }];
    case 'num':
      return typeof value === 'number' && Number.isFinite(value) ? [] : [{ path, code: 'type' }];
    case 'bool':
      return typeof value === 'boolean' ? [] : [{ path, code: 'type' }];
    default:
      return [];
  }
}

/** The node for a top-level payload module, e.g. `smoke_alarm`. */
export function moduleNode(schema: CompiledNerisSchema, module: string): SchemaNode | undefined {
  const root = resolveNode(schema, { k: 'ref', n: PAYLOAD_ROOT });
  return root.k === 'obj' ? root.p[module] : undefined;
}

/** `FIRE||STRUCTURE_FIRE||ROOM_AND_CONTENTS_FIRE` -> `Fire › Structure fire › Room and contents fire`. */
export function incidentTypeLabel(value: string): string {
  return value
    .split('||')
    .map((part) => {
      const words = part.toLowerCase().replace(/_/g, ' ');
      return words.charAt(0).toUpperCase() + words.slice(1);
    })
    .join(' › ');
}

/** Paths of keys the schema does not declare (NERIS answers `extra_forbidden` for these). */
export function findUndeclaredKeys(
  schema: CompiledNerisSchema,
  node: SchemaNode,
  value: unknown,
  path = '',
): string[] {
  const resolved = resolveNode(schema, node);
  const at = (key: string | number) =>
    typeof key === 'number' ? `${path}[${key}]` : path ? `${path}.${key}` : key;
  if (resolved.k === 'obj') {
    const record = asRecord(value);
    if (!record) return [];
    return Object.entries(record).flatMap(([key, child]) =>
      resolved.p[key] === undefined
        ? [at(key)]
        : child === null
          ? []
          : findUndeclaredKeys(schema, resolved.p[key], child, at(key)),
    );
  }
  if (resolved.k === 'arr' && Array.isArray(value)) {
    return value.flatMap((item, index) => findUndeclaredKeys(schema, resolved.i, item, at(index)));
  }
  if (resolved.k === 'union') {
    const option = selectOption(schema, resolved, value);
    return option ? findUndeclaredKeys(schema, option, value, path) : [];
  }
  return [];
}

/** A module's node plus exactly the named schemas it references, for the web editors. */
export function moduleSubschema(
  schema: CompiledNerisSchema,
  module: string,
): { readonly node: SchemaNode; readonly defs: Record<string, SchemaNode> } | undefined {
  const node = moduleNode(schema, module);
  if (!node) return undefined;
  const defs: Record<string, SchemaNode> = {};
  const visit = (current: SchemaNode): void => {
    if (current.k === 'ref') {
      if (defs[current.n]) return;
      const target = schema.defs[current.n];
      if (!target) return;
      defs[current.n] = target;
      visit(target);
    } else if (current.k === 'obj') {
      Object.values(current.p).forEach(visit);
    } else if (current.k === 'arr') {
      visit(current.i);
    } else if (current.k === 'union') {
      current.o.forEach(visit);
    }
  };
  visit(node);
  return { node, defs };
}
