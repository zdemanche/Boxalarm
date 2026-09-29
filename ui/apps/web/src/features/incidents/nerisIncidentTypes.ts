import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { getNerisSchema } from './api';
import type { NerisIncidentType } from './types';

/** The server refreshes the NERIS schema daily; an hour is plenty fresh for a picker. */
const NERIS_SCHEMA_STALE_MS = 60 * 60 * 1000;

/** GET incidents/neris-schema, shared by the incident type picker and the module editors. */
export function useNerisSchema() {
  const auth = useAuth();
  return useQuery({
    queryKey: ['neris-schema'],
    queryFn: () => getNerisSchema(auth),
    staleTime: NERIS_SCHEMA_STALE_MS,
    retry: false,
  });
}

/** Readable names for the first TypeIncidentValue segment; the server's label is the fallback. */
const GROUP_LABEL: Record<string, string> = {
  FIRE: 'Fire',
  HAZSIT: 'Hazardous situation',
  MEDICAL: 'Medical',
  NOEMERG: 'No emergency',
  PUBSERV: 'Public service',
  RESCUE: 'Rescue',
  LAWENFORCE: 'Law enforcement',
};

const LABEL_SEPARATOR = ' › ';

export interface IncidentTypeGroup {
  key: string;
  label: string;
  /** `label` here is the type's label without the group segment. */
  options: NerisIncidentType[];
}

export function incidentTypeGroupKey(value: string): string {
  return value.split('||')[0] ?? value;
}

/** Groups the NERIS types by their first segment (Fire, Medical, ...), keeping server order. */
export function groupIncidentTypes(types: readonly NerisIncidentType[]): IncidentTypeGroup[] {
  const groups = new Map<string, IncidentTypeGroup>();
  for (const type of types) {
    const key = incidentTypeGroupKey(type.value);
    const [first, ...rest] = type.label.split(LABEL_SEPARATOR);
    const groupLabel = GROUP_LABEL[key] ?? first ?? key;
    const group = groups.get(key) ?? { key, label: groupLabel, options: [] };
    group.options.push({
      value: type.value,
      label: rest.length > 0 ? rest.join(LABEL_SEPARATOR) : groupLabel,
    });
    groups.set(key, group);
  }
  return [...groups.values()];
}
