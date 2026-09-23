import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SERVICES } from '../src/services/index.js';

const serviceDir = (name: string) =>
  fileURLToPath(new URL(`../src/services/${name}/index.ts`, import.meta.url));

describe('service inventory', () => {
  it('holds the ten architecture services with unique names', () => {
    expect(SERVICES).toHaveLength(10);
    expect(new Set(SERVICES.map((s) => s.name)).size).toBe(10);
  });

  it('places exactly one service in the alerting plane', () => {
    expect(SERVICES.filter((s) => s.plane === 'alerting').map((s) => s.name)).toEqual([
      'alerting-service',
    ]);
  });

  it('has a source directory for every registered service', () => {
    for (const s of SERVICES) {
      expect(existsSync(serviceDir(s.name)), s.name).toBe(true);
    }
  });
});
