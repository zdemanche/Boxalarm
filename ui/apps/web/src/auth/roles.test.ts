import { describe, expect, test } from 'vitest';
import {
  canCreateApparatus,
  canManageInventory,
  canManageTraining,
  canUpdateServiceStatus,
  rolesFromProfile,
  type Role,
} from './roles';

describe('rolesFromProfile', () => {
  test('reads cognito:groups and maps known groups to Role', () => {
    expect(rolesFromProfile({ 'cognito:groups': ['CHIEF', 'OFFICER'] })).toEqual([
      'CHIEF',
      'OFFICER',
    ] satisfies Role[]);
  });

  test('normalizes mixed-case cognito group names', () => {
    expect(rolesFromProfile({ 'cognito:groups': ['chief', 'Admin'] })).toEqual(['CHIEF', 'ADMIN']);
  });

  test('falls back to MEMBER when cognito:groups is missing or empty', () => {
    expect(rolesFromProfile({ sub: 'm1' })).toEqual(['MEMBER']);
    expect(rolesFromProfile({ 'cognito:groups': [] })).toEqual(['MEMBER']);
  });

  test('ignores unknown groups and falls back to MEMBER when none known', () => {
    expect(rolesFromProfile({ 'cognito:groups': ['SOME_CUSTOM_GROUP'] })).toEqual(['MEMBER']);
  });

  test('prefers cognito:groups over a legacy roles claim', () => {
    expect(
      rolesFromProfile({
        'cognito:groups': ['TRAINING'],
        roles: ['CHIEF'],
      }),
    ).toEqual(['TRAINING']);
  });

  test('does not use legacy roles when cognito:groups is absent (claim is never issued)', () => {
    expect(rolesFromProfile({ roles: ['CHIEF'] })).toEqual(['MEMBER']);
  });
});

describe('canManageTraining', () => {
  test.each<[Role[], boolean]>([
    [['TRAINING'], true],
    [['ADMIN'], true],
    [['MEMBER', 'TRAINING'], true],
    [['CHIEF'], false],
    [['OFFICER'], false],
    [['MEMBER'], false],
  ])('%j -> %s', (roles, expected) => {
    expect(canManageTraining(roles)).toBe(expected);
  });
});

test('write-control helpers mirror the Cedar groups (review m6)', () => {
  expect(canUpdateServiceStatus(['OFFICER'])).toBe(true);
  expect(canUpdateServiceStatus(['ADMIN'])).toBe(true);
  expect(canUpdateServiceStatus(['TRAINING'])).toBe(false);
  expect(canManageInventory(['OFFICER'])).toBe(true);
  expect(canManageInventory(['APPARATUS'])).toBe(false);
  expect(canCreateApparatus(['APPARATUS'])).toBe(false);
  expect(canCreateApparatus(['ADMIN'])).toBe(true);
});

// Security-web MINOR 2: Submit is the NERIS officer tier (Cedar SubmitIncidentReport).
test('canSubmitIncident admits OFFICER, CHIEF and ADMIN only', async () => {
  const { canSubmitIncident } = await import('./roles');
  expect(canSubmitIncident(['OFFICER'])).toBe(true);
  expect(canSubmitIncident(['CHIEF'])).toBe(true);
  expect(canSubmitIncident(['ADMIN'])).toBe(true);
  expect(canSubmitIncident(['MEMBER', 'TRAINING'])).toBe(false);
});

test('starting a report and listing dispatches admit OFFICER, CHIEF and ADMIN only', async () => {
  const { canStartIncidentReport, canListRecentDispatches } = await import('./roles');
  for (const helper of [canStartIncidentReport, canListRecentDispatches]) {
    expect(helper(['OFFICER'])).toBe(true);
    expect(helper(['CHIEF'])).toBe(true);
    expect(helper(['ADMIN'])).toBe(true);
    expect(helper(['MEMBER'])).toBe(false);
    expect(helper(['TRAINING', 'APPARATUS'])).toBe(false);
  }
});

// #161: RecordCutoverDecision is CHIEF/ADMIN only, same tier as ExportReport (policy-store.test.ts
// ADMIN_WRITES) — reading the decision is every reporting role and is not gated by this helper.
test('canRecordCutoverDecision admits only CHIEF and ADMIN', async () => {
  const { canRecordCutoverDecision } = await import('./roles');
  expect(canRecordCutoverDecision(['CHIEF'])).toBe(true);
  expect(canRecordCutoverDecision(['ADMIN'])).toBe(true);
  expect(canRecordCutoverDecision(['OFFICER'])).toBe(false);
  expect(canRecordCutoverDecision(['TRAINING'])).toBe(false);
  expect(canRecordCutoverDecision(['MEMBER', 'APPARATUS'])).toBe(false);
});
