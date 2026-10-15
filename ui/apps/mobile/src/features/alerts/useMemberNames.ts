import { useEffect, useState } from 'react';
import type { AlertsRepository, RosterEntry } from './types';

const CACHE_MS = 60_000;

let cache = new WeakMap<AlertsRepository, { at: number; names: Promise<Record<string, string>> }>();

export function resetMemberNamesCache(): void {
  cache = new WeakMap();
}

function memberNames(repository: AlertsRepository): Promise<Record<string, string>> {
  const hit = cache.get(repository);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.names;
  const names = repository.listMemberNames();
  cache.set(repository, { at: Date.now(), names });
  names.catch(() => cache.delete(repository));
  return names;
}

export interface MemberNames {
  nameOf: (memberId: string) => string;
  displayName: (entry: RosterEntry) => string;
  failed: boolean;
}

export function useMemberNames(repository: AlertsRepository): MemberNames {
  const [names, setNames] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    memberNames(repository).then(
      (result) => {
        if (cancelled) return;
        setNames(result);
        setFailed(false);
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [repository]);

  const nameOf = (memberId: string) => names[memberId] ?? memberId;
  const displayName = (entry: RosterEntry) =>
    entry.name !== entry.memberId ? entry.name : nameOf(entry.memberId);
  return { nameOf, displayName, failed };
}
