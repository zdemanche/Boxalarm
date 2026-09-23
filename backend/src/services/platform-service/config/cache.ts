export interface CacheEntry<T> {
  readonly value: T;
  readonly expiresAt: number;
}

export interface CacheStore {
  get<T>(key: string): CacheEntry<T> | undefined;
  set<T>(key: string, entry: CacheEntry<T>): void;
  delete(key: string): void;
}

export interface ConfigCacheOptions {
  readonly ttlMs: number;
  readonly now?: () => number;
  readonly store?: CacheStore;
}

export interface ConfigCache {
  getOrLoad<T>(pk: string, sk: string, loader: () => Promise<T>): Promise<T>;
  invalidate(pk: string, sk: string): void;
}

function memoryStore(): CacheStore {
  const map = new Map<string, CacheEntry<unknown>>();
  return {
    get<T>(key: string): CacheEntry<T> | undefined {
      return map.get(key) as CacheEntry<T> | undefined;
    },
    set<T>(key: string, entry: CacheEntry<T>): void {
      map.set(key, entry);
    },
    delete(key: string): void {
      map.delete(key);
    },
  };
}

const DEPT_PK_PREFIX = 'DEPT#';
const CONFIG_SK_PREFIX = 'CONFIG#';

function cacheKey(pk: string, sk: string): string {
  const deptId = pk.startsWith(DEPT_PK_PREFIX) ? pk.slice(DEPT_PK_PREFIX.length) : pk;
  const configType = sk.startsWith(CONFIG_SK_PREFIX) ? sk.slice(CONFIG_SK_PREFIX.length) : sk;
  return `platform-service:department-config:${deptId}:${configType}`;
}

/**
 * Soft-dependency cache in front of DEPARTMENT_CONFIG reads.
 *
 * `store` accepts any `CacheStore` implementation (e.g. a Valkey/ElastiCache-backed
 * one), but as of this writing no such store is actually wired in anywhere —
 * `createHandler()` in `handler.ts` always falls back to the process-local
 * `memoryStore()` below, since no Valkey client dependency or endpoint config
 * exists yet in this repo. That means cache state does not survive across
 * separate Lambda execution environments except via container reuse, so the
 * cross-invocation benefit at real concurrency is negligible today. Wiring a
 * real remote store is tracked as a follow-up, not yet implemented here.
 *
 * Regardless of which store is injected, failures fall through to the
 * DynamoDB loader so a cache outage never fails the request (E8-S4 AC3).
 */
export function createConfigCache(options: ConfigCacheOptions): ConfigCache {
  const ttlMs = options.ttlMs;
  const now = options.now ?? Date.now;
  const store = options.store ?? memoryStore();

  return {
    async getOrLoad<T>(pk: string, sk: string, loader: () => Promise<T>): Promise<T> {
      const key = cacheKey(pk, sk);
      try {
        const hit = store.get<T>(key);
        if (hit && hit.expiresAt > now()) {
          return hit.value;
        }
      } catch {
        // Cache get failed — fall through to loader.
      }

      const value = await loader();

      try {
        store.set(key, { value, expiresAt: now() + ttlMs });
      } catch {
        // Cache set failed — still return the loaded value.
      }

      return value;
    },

    invalidate(pk: string, sk: string): void {
      try {
        store.delete(cacheKey(pk, sk));
      } catch {
        // Soft dependency: invalidation failure is non-fatal.
      }
    },
  };
}

/** Architecture §6 Valkey TTL for DEPARTMENT_CONFIG — 5 minutes. */
export const DEPARTMENT_CONFIG_CACHE_TTL_MS = 5 * 60 * 1000;
