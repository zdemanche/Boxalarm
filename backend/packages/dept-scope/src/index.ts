declare const verifiedDeptIdBrand: unique symbol;

export type VerifiedDeptId = string & { readonly [verifiedDeptIdBrand]: true };

export interface VerifiedPrincipal {
  readonly deptId: string;
}

function assertNoDelimiter(value: string, label: string): void {
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
  /["'`]?\bpk\b["'`]?\s*[:=]\s*(`[^`]*`|'[^']*'|"[^"]*"|\{\s*S:\s*(?:`[^`]*`|'[^']*'|"[^"]*")\s*\}|[A-Za-z_$][\w$]*(?:\([^)]*\))?)/gi;
const REQUIRED_PK_PREFIX = 'DEPT#${deptId}';
const BUILDER_CALL_PREFIX = 'buildDeptScopedPk(';

function unwrapLiteral(value: string): string | undefined {
  const literalMatch = value.match(/^[`'"]([\s\S]*)[`'"]$/);
  if (literalMatch) {
    return literalMatch[1];
  }
  const marshalledMatch = value.match(/^\{\s*S:\s*[`'"]([\s\S]*)[`'"]\s*\}$/);
  return marshalledMatch ? marshalledMatch[1] : undefined;
}

// ponytail: regex sweep over source text, not AST — upgrade to a custom eslint rule if false positives appear on real entity code
export function findPkScopingViolations(sourceText: string): readonly string[] {
  const violations: string[] = [];
  for (const match of sourceText.matchAll(PK_ASSIGNMENT)) {
    const rhs = match[1] ?? '';
    if (rhs.startsWith(BUILDER_CALL_PREFIX)) {
      continue;
    }
    const literal = unwrapLiteral(rhs);
    if (literal === undefined || !literal.startsWith(REQUIRED_PK_PREFIX)) {
      violations.push(match[0].trim());
    }
  }
  return violations;
}
