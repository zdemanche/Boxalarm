declare const verifiedDeptIdBrand: unique symbol;

export type VerifiedDeptId = string & { readonly [verifiedDeptIdBrand]: true };

export interface VerifiedPrincipal {
  readonly deptId: string;
}

export function assertNoDelimiter(value: string, label: string): void {
  if (value.includes('#')) {
    throw new Error(
      `${label} cannot contain '#', the department-scoped pk delimiter: received "${value}"`,
    );
  }
}

export function toVerifiedDeptId(principal: VerifiedPrincipal): VerifiedDeptId {
  const deptId = principal.deptId;
  if (!deptId) {
    throw new Error('deptId is required on the verified principal');
  }
  assertNoDelimiter(deptId, 'deptId');
  return deptId as VerifiedDeptId;
}

export function buildDeptScopedPk(deptId: VerifiedDeptId, ...segments: readonly string[]): string {
  if (!deptId) {
    throw new Error('deptId is required to build a department-scoped pk');
  }
  assertNoDelimiter(deptId, 'deptId');
  segments.forEach((segment, index) => {
    if (!segment) {
      throw new Error(`segment at index ${index} is required to build a department-scoped pk`);
    }
    assertNoDelimiter(segment, `segment at index ${index}`);
  });
  return segments.length === 0 ? `DEPT#${deptId}` : `DEPT#${deptId}#${segments.join('#')}`;
}

const PK_ASSIGNMENT =
  /["'`]?\bpk\b["'`]?\s*([:=])\s*(`[^`]*`|'[^']*'|"[^"]*"|\{\s*S:\s*(?:`[^`]*`|'[^']*'|"[^"]*")\s*\}|[A-Za-z_$][\w$]*(?:\([^)]*\))?)/gi;
const REQUIRED_PK_PREFIX = 'DEPT#${deptId}';
const BUILDER_CALL_PREFIX = 'buildDeptScopedPk(';

// Reference data shared across every department (not per-tenant), so it is intentionally
// NOT department-scoped: incident-service's SCHEMA_VERSION (architecture Data Model §3.2 —
// one NERIS schema registry for the whole system). Each entry here is a deliberate,
// documented exception to the dept-scoping invariant below, never a default.
const KNOWN_GLOBAL_PK_LITERALS = new Set(['SCHEMA_VERSION']);

function unwrapLiteral(value: string): string | undefined {
  const literalMatch = value.match(/^[`'"]([\s\S]*)[`'"]$/);
  if (literalMatch) {
    return literalMatch[1];
  }
  const marshalledMatch = value.match(/^\{\s*S:\s*[`'"]([\s\S]*)[`'"]\s*\}$/);
  return marshalledMatch ? marshalledMatch[1] : undefined;
}

// TS primitive type keywords a bare RHS can equal only in a `pk: string`-style type
// annotation (an interface field or a function's object-literal return type) — never a
// real value assignment, which is always a quoted literal or a builder call. Only
// relevant when the matched delimiter is ':' — a `=` delimiter is always a value
// assignment (e.g. `const pk = string;` assigning an identifier literally named
// `string`), never a type annotation, so it must still be checked as a violation.
const TS_PRIMITIVE_TYPE_KEYWORDS = new Set(['string']);

// ponytail: regex sweep over source text, not AST — upgrade to a custom eslint rule if false positives appear on real entity code
export function findPkScopingViolations(sourceText: string): readonly string[] {
  const violations: string[] = [];
  for (const match of sourceText.matchAll(PK_ASSIGNMENT)) {
    const delimiter = match[1];
    const rhs = match[2] ?? '';
    if (rhs.startsWith(BUILDER_CALL_PREFIX)) {
      continue;
    }
    if (delimiter === ':' && TS_PRIMITIVE_TYPE_KEYWORDS.has(rhs)) {
      const afterMatch = sourceText.slice((match.index ?? 0) + match[0].length);
      const isDeclarationWithInitializer = /^\s*=(?!=)/.test(afterMatch);
      if (!isDeclarationWithInitializer) {
        continue;
      }
    }
    const literal = unwrapLiteral(rhs);
    if (literal !== undefined && KNOWN_GLOBAL_PK_LITERALS.has(literal)) {
      continue;
    }
    if (literal === undefined || !literal.startsWith(REQUIRED_PK_PREFIX)) {
      violations.push(match[0].trim());
    }
  }
  return violations;
}
