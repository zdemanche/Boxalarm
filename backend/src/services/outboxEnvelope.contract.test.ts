import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  buildOutboxRecord,
  missingOutboxEnvelopeFields,
  OUTBOX_ENVELOPE_FIELDS,
} from '@boxalarm/outbox';

/**
 * Every OUTBOX_ENTRY a service writes must carry the envelope the outbox drain publishes
 * (@boxalarm/outbox drainHandler: OUTBOX_ENVELOPE_FIELDS + an object payload). A row without
 * it is never published: availability mark-offs were dropped this way, so a marked-off member
 * was still paged and an expired mark-off never reached the alerting snapshot (post-merge).
 *
 * Writers either call buildOutboxRecord (checked by running it through the drain's own check)
 * or write an object literal with `entityType: 'OUTBOX_ENTRY'` (checked statically: the
 * literal must name every envelope field). A literal built by spreading another object cannot
 * be checked here; none exists today, and the test fails on one so it gets a look.
 */

const SERVICES_ROOT = __dirname;
// pk/sk are the table key: DynamoDB refuses a Put without them, and some writers build the
// envelope in a helper and add the key at the call site (quals/repository.ts buildOutboxEntry).
const REQUIRED = [
  ...OUTBOX_ENVELOPE_FIELDS.filter((field) => field !== 'pk' && field !== 'sk'),
  'payload',
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) ? [full] : [];
  });
}

/** The object literal around `index`: from its `{` to the matching `}`. */
function enclosingLiteral(src: string, index: number): string {
  let depth = 0;
  let start = index;
  for (; start >= 0; start -= 1) {
    const char = src[start];
    if (char === '}') depth += 1;
    if (char === '{') {
      if (depth === 0) break;
      depth -= 1;
    }
  }
  depth = 0;
  let end = start;
  for (; end < src.length; end += 1) {
    if (src[end] === '{') depth += 1;
    if (src[end] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return src.slice(start, end + 1);
}

/** Top-level keys of an object literal (nested literals collapsed first). */
function topLevelKeys(literal: string): { keys: Set<string>; spreads: boolean } {
  let body = literal.slice(1, -1).replace(/\/\/.*$/gm, '');
  let previous: string;
  do {
    previous = body;
    body = body.replace(/\{[^{}]*\}/g, '0').replace(/\([^()]*\)/g, '0');
  } while (body !== previous);
  const keys = new Set(
    [...body.matchAll(/(?:^|,)\s*([A-Za-z_$][\w$]*)\s*(?=[:,]|$)/g)].map((m) => m[1]!),
  );
  return { keys, spreads: /(?:^|,)\s*\.\.\./.test(body) };
}

describe('outbox writers ↔ outbox drain envelope contract', () => {
  const writers = sourceFiles(SERVICES_ROOT).flatMap((file) => {
    const src = readFileSync(file, 'utf8');
    return [...src.matchAll(/entityType:\s*'OUTBOX_ENTRY'/g)].map((match) => ({
      where: `${relative(SERVICES_ROOT, file)}:${src.slice(0, match.index).split('\n').length}`,
      literal: enclosingLiteral(src, match.index),
    }));
  });

  it('finds the literal OUTBOX_ENTRY writers (the scan is not silently empty)', () => {
    expect(writers.length).toBeGreaterThan(10);
  });

  it('every literal OUTBOX_ENTRY row names every field the drain requires', () => {
    const problems = writers.flatMap(({ where, literal }) => {
      const { keys, spreads } = topLevelKeys(literal);
      const missing = REQUIRED.filter((field) => !keys.has(field));
      if (missing.length === 0) return [];
      return [`${where}: missing ${missing.join(', ')}${spreads ? ' (built with a spread)' : ''}`];
    });
    expect(problems).toEqual([]);
  });

  it('buildOutboxRecord produces a row the drain publishes', () => {
    const row = buildOutboxRecord(
      toVerifiedDeptId({ deptId: 'NICHOLS' }),
      'personnel-service',
      'personnel.availability.changed',
      'mbr-1',
      { memberId: 'mbr-1' },
    );
    expect(missingOutboxEnvelopeFields(row as unknown as Record<string, unknown>)).toEqual([]);
  });

  it('the static check catches a row without the envelope', () => {
    const { keys } = topLevelKeys(
      "{ pk: 'x', sk: `EVT#${id}`, entityType: 'OUTBOX_ENTRY', eventId, eventType: 'e', correlationId: m, createdAt: now, payload: { deptId, memberId } }",
    );
    expect(REQUIRED.filter((field) => !keys.has(field))).toEqual([
      'eventTime',
      'source',
      'schemaVersion',
    ]);
  });
});
