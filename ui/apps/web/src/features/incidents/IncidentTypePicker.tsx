import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Select } from '../../components/ui/Field';
import { groupIncidentTypes, incidentTypeGroupKey } from './nerisIncidentTypes';
import type { NerisIncidentType } from './types';
import styles from './IncidentDetail.module.css';

export type IncidentTypesState =
  | { status: 'loading' }
  | { status: 'unavailable'; retry: () => void }
  | { status: 'ready'; types: readonly NerisIncidentType[] };

/**
 * The NERIS incident type (TypeIncidentValue) as two native selects: a category (Fire, Medical,
 * ...) that narrows the ~140 types, then the type itself. Native selects give the phone's own
 * large-row picker for gloved hands and full keyboard / screen-reader support.
 */
export function IncidentTypePicker({
  value,
  onChange,
  error,
  state,
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string;
  state: IncidentTypesState;
}) {
  const types = state.status === 'ready' ? state.types : [];
  const selected = types.find((type) => type.value === value);
  const [category, setCategory] = useState(() =>
    selected ? incidentTypeGroupKey(selected.value) : '',
  );

  if (state.status === 'loading') {
    return (
      <p id="field-incident_type" tabIndex={-1} aria-busy="true" className={styles.span}>
        Loading the NERIS incident types.
      </p>
    );
  }

  if (state.status === 'unavailable') {
    return (
      <div id="field-incident_type" tabIndex={-1} role="status" className={styles.span}>
        <p>
          NERIS incident types are not downloaded yet. The list refreshes daily; the other fields on
          this step still save.
        </p>
        {value ? <p>Stored incident type: {value}</p> : null}
        <Button type="button" variant="secondary" onClick={state.retry}>
          Try again
        </Button>
      </div>
    );
  }

  const groups = groupIncidentTypes(types);
  const visible = category ? groups.filter((group) => group.key === category) : groups;
  const help = selected
    ? `Selected: ${selected.label}`
    : value
      ? `Not a NERIS type: ${value} — pick one.`
      : undefined;

  return (
    <>
      <Select
        id="field-incident_type-category"
        label="Incident category"
        optional
        help="Narrows the list of NERIS incident types."
        value={category}
        onChange={(event) => {
          const next = event.target.value;
          setCategory(next);
          if (selected && next && incidentTypeGroupKey(selected.value) !== next) onChange('');
        }}
      >
        <option value="">All categories</option>
        {groups.map((group) => (
          <option key={group.key} value={group.key}>
            {group.label}
          </option>
        ))}
      </Select>
      <Select
        id="field-incident_type"
        label="NERIS incident type"
        value={selected ? selected.value : ''}
        help={help}
        error={error}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">Choose an incident type</option>
        {visible.map((group) => (
          <optgroup key={group.key} label={group.label}>
            {group.options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </optgroup>
        ))}
      </Select>
    </>
  );
}
