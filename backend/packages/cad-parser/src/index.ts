import { createHash } from 'node:crypto';

/**
 * Per-source CAD dispatch parser (docs/decisions/2026-09-29-roadmap-defaults.md row 3).
 *
 * A department authors one template per CAD source: for each field, either a line label
 * ("ADDRESS" matches a line "ADDRESS: 123 MAIN ST") or a regular expression whose first
 * capture group is the value. The template is validated when it is saved, compiled once per
 * use, and carries a version so every dispatch records which template read it.
 *
 * Parsing FAILS OPEN: text the template cannot structure is still a dispatch, returned as
 * RAW so the caller pages with the raw text and "SEE DISPATCH TEXT". That is only safe
 * because the caller has already authenticated the sender (2026-09-29-cad-ingress-auth.md);
 * this package never decides trust.
 *
 * Shared by alerting (the ingress Lambdas) and the platform config route (validation and
 * the test-parse preview), so the preview is the same code that reads real dispatches.
 */

export const CAD_FIELDS = [
  'incidentNumber',
  'dispatchTime',
  'incidentType',
  'address',
  'crossStreets',
  'town',
  'units',
  'narrative',
] as const;

export type CadField = (typeof CAD_FIELDS)[number];

export interface CadFieldRule {
  /** Line label, matched case-insensitively at the start of a line, then ':' or '-'. */
  readonly label?: string;
  /** Regular expression (case-insensitive, multiline); the first capture group is the value. */
  readonly pattern?: string;
}

export interface CadParserTemplate {
  readonly version: number;
  readonly fields: Partial<Record<CadField, CadFieldRule>>;
}

export type CadParsedFields = Partial<Record<CadField, string>>;

export type CadParseResult =
  | { readonly status: 'PARSED'; readonly version: number; readonly fields: CadParsedFields }
  | {
      readonly status: 'RAW';
      readonly version: number | null;
      readonly reason: 'NO_TEMPLATE' | 'NO_ADDRESS' | 'EMPTY';
      readonly fields: CadParsedFields;
    };

export interface TemplateError {
  readonly field: string;
  readonly message: string;
}

/** The text a parser reads is capped: a regex never runs over more than this. */
export const MAX_PARSE_CHARS = 16_384;
export const MAX_PATTERN_LENGTH = 200;
export const MAX_LABEL_LENGTH = 40;
const MAX_FIELD_CHARS = 500;
export const MAX_NARRATIVE_CHARS = 4_000;

/**
 * A quantified group that itself contains a quantifier - `(a+)+`, `(\w*)*`, `(x+){2,}` - is
 * the classic catastrophic-backtracking shape. JavaScript regexes have no timeout, so these
 * are refused when the template is saved rather than risk a stuck ingress Lambda.
 */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) < 0x20);
}

/** Validates a template as saved by a chief. Unknown fields and keys are errors. */
export function validateCadParserTemplate(
  raw: unknown,
  prefix = 'parser',
): { ok: true; template: CadParserTemplate } | { ok: false; errors: TemplateError[] } {
  const errors: TemplateError[] = [];
  if (!isRecord(raw)) {
    return { ok: false, errors: [{ field: prefix, message: 'must be an object' }] };
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'version' && key !== 'fields') {
      errors.push({ field: `${prefix}.${key}`, message: 'is not a recognized field' });
    }
  }
  const version = raw.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    errors.push({ field: `${prefix}.version`, message: 'must be a whole number from 1' });
  }
  const fields: Partial<Record<CadField, CadFieldRule>> = {};
  if (!isRecord(raw.fields)) {
    errors.push({ field: `${prefix}.fields`, message: 'must be an object' });
  } else {
    for (const [name, rule] of Object.entries(raw.fields)) {
      const where = `${prefix}.fields.${name}`;
      if (!(CAD_FIELDS as readonly string[]).includes(name)) {
        errors.push({ field: where, message: `is not one of ${CAD_FIELDS.join(', ')}` });
        continue;
      }
      if (!isRecord(rule)) {
        errors.push({ field: where, message: 'must be an object { label } or { pattern }' });
        continue;
      }
      for (const key of Object.keys(rule)) {
        if (key !== 'label' && key !== 'pattern') {
          errors.push({ field: `${where}.${key}`, message: 'is not a recognized field' });
        }
      }
      const { label, pattern } = rule;
      if ((label === undefined) === (pattern === undefined)) {
        errors.push({ field: where, message: 'needs exactly one of label or pattern' });
        continue;
      }
      if (label !== undefined) {
        if (
          typeof label !== 'string' ||
          label.trim().length === 0 ||
          label.length > MAX_LABEL_LENGTH ||
          hasControlCharacter(label)
        ) {
          errors.push({
            field: `${where}.label`,
            message: `must be 1-${MAX_LABEL_LENGTH} characters of text`,
          });
          continue;
        }
        fields[name as CadField] = { label: label.trim() };
        continue;
      }
      if (typeof pattern !== 'string' || pattern.length === 0) {
        errors.push({ field: `${where}.pattern`, message: 'must be a non-empty string' });
        continue;
      }
      if (pattern.length > MAX_PATTERN_LENGTH) {
        errors.push({
          field: `${where}.pattern`,
          message: `must be at most ${MAX_PATTERN_LENGTH} characters`,
        });
        continue;
      }
      if (NESTED_QUANTIFIER.test(pattern)) {
        errors.push({
          field: `${where}.pattern`,
          message: 'must not repeat a group that itself repeats, e.g. (a+)+ (it can hang)',
        });
        continue;
      }
      try {
        new RegExp(pattern, 'im');
      } catch {
        errors.push({ field: `${where}.pattern`, message: 'is not a valid regular expression' });
        continue;
      }
      fields[name as CadField] = { pattern };
    }
    if (!fields.address && !errors.some((e) => e.field.startsWith(`${prefix}.fields.address`))) {
      errors.push({
        field: `${prefix}.fields.address`,
        message: 'is required: a dispatch is structured only when its address is found',
      });
    }
  }
  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, template: { version: version as number, fields } };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

type Extractor = (text: string) => string | undefined;

function compileRule(field: CadField, rule: CadFieldRule): Extractor {
  if (rule.label !== undefined) {
    // The narrative runs from its label to the end of the text; every other field is the rest
    // of its line.
    const tail = field === 'narrative' ? '([\\s\\S]*)' : '([^\\n]*)';
    const expression = new RegExp(
      `^[ \\t]*${escapeRegExp(rule.label)}[ \\t]*[:\\-][ \\t]*${tail}`,
      'im',
    );
    return (text) => expression.exec(text)?.[1];
  }
  const expression = new RegExp(rule.pattern as string, 'im');
  return (text) => {
    const match = expression.exec(text);
    return match ? (match[1] ?? match[0]) : undefined;
  };
}

function clean(field: CadField, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const max = field === 'narrative' ? MAX_NARRATIVE_CHARS : MAX_FIELD_CHARS;
  const text =
    field === 'narrative'
      ? value.replace(/[ \t]+/g, ' ').trim()
      : value.replace(/\s+/g, ' ').trim();
  return text.length === 0 ? undefined : text.slice(0, max);
}

/** CRLF to LF, NUL and other control characters (except tab/newline) removed, capped. */
export function normalizeDispatchText(text: string): string {
  return (
    text
      .replace(/\r\n?/g, '\n')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .slice(0, MAX_PARSE_CHARS)
  );
}

export interface CompiledCadParser {
  readonly version: number;
  parse(text: string): CadParseResult;
}

export function compileCadParser(template: CadParserTemplate): CompiledCadParser {
  const extractors = (Object.entries(template.fields) as [CadField, CadFieldRule][]).map(
    ([field, rule]) => [field, compileRule(field, rule)] as const,
  );
  return {
    version: template.version,
    parse(text: string): CadParseResult {
      const normalized = normalizeDispatchText(text);
      if (normalized.trim().length === 0) {
        return { status: 'RAW', version: template.version, reason: 'EMPTY', fields: {} };
      }
      const fields: CadParsedFields = {};
      for (const [field, extract] of extractors) {
        const value = clean(field, extract(normalized));
        if (value !== undefined) fields[field] = value;
      }
      return fields.address
        ? { status: 'PARSED', version: template.version, fields }
        : { status: 'RAW', version: template.version, reason: 'NO_ADDRESS', fields };
    },
  };
}

/** Parse with an optional template: no template is a RAW result, never an error. */
export function parseCadText(
  template: CadParserTemplate | undefined,
  text: string,
): CadParseResult {
  if (!template) {
    return {
      status: 'RAW',
      version: null,
      reason: normalizeDispatchText(text).trim().length === 0 ? 'EMPTY' : 'NO_TEMPLATE',
      fields: {},
    };
  }
  return compileCadParser(template).parse(text);
}

/**
 * A stable fingerprint of dispatch text: whitespace-insensitive, so a resend that re-wraps
 * lines or changes line endings still collapses to the same dispatch.
 */
export function dispatchTextFingerprint(text: string): string {
  const collapsed = normalizeDispatchText(text).replace(/\s+/g, ' ').trim().toUpperCase();
  return createHash('sha256').update(collapsed, 'utf8').digest('hex');
}
