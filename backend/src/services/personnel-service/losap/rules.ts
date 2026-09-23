import type { ActivityType } from '../attendance/handler.js';

export type LosapPointRules = Partial<Record<ActivityType, number>>;

export function computeLosapPoints(activityType: ActivityType, rules: LosapPointRules): number {
  const points = rules[activityType];
  return typeof points === 'number' && Number.isFinite(points) ? points : 0;
}

export function isValidLosapPointRules(
  value: unknown,
  activityTypes: readonly string[],
): value is LosapPointRules {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    return false;
  }
  return entries.every(
    ([key, points]) =>
      activityTypes.includes(key) &&
      typeof points === 'number' &&
      Number.isFinite(points) &&
      points >= 0,
  );
}
