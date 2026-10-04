import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../../lib/apiClient';
import { Button } from '../../components/ui/Button';
import { StatusChip } from '../../components/ui/Chip';
import { Select, TextInput } from '../../components/ui/Field';
import { fieldErrorsFromUnknown } from './api';
import {
  asRecord,
  controlId,
  humanize,
  humanizePath,
  pruneValue,
  resolveNode,
  unionChoices,
  type Defs,
  type JsonRecord,
  type SchemaNode,
} from './nerisModuleSchema';
import type { NerisModuleSchema } from './types';
import type { FieldError } from './validateEnum';
import styles from './NerisModuleEditor.module.css';

interface Choice {
  value: string;
  label: string;
}

/** A labelled group of native radios; the first radio carries the group's control id. */
function ChoiceGroup({
  id,
  legend,
  choices,
  selected,
  onSelect,
  error,
  children,
}: {
  id: string;
  legend: string;
  choices: Choice[];
  selected: string;
  onSelect: (value: string) => void;
  error?: string;
  children?: ReactNode;
}) {
  const errorId = `${id}-error`;
  return (
    <fieldset className={styles.group} aria-describedby={error ? errorId : undefined}>
      <legend>{legend}</legend>
      {choices.map((choice, index) => (
        <label key={choice.value} className={styles.choice}>
          <input
            type="radio"
            id={index === 0 ? id : `${id}-${index}`}
            name={id}
            value={choice.value}
            checked={selected === choice.value}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            onChange={() => onSelect(choice.value)}
          />
          {choice.label}
        </label>
      ))}
      {error ? (
        <p id={errorId} className={styles.error}>
          {error}
        </p>
      ) : null}
      {children}
    </fieldset>
  );
}

/** "Select all that apply" as native checkboxes; the first one carries the group's control id. */
function CheckGroup({
  id,
  legend,
  choices,
  checked,
  onToggle,
  error,
  children,
}: {
  id: string;
  legend: string;
  choices: Choice[];
  checked: readonly string[];
  onToggle: (value: string, on: boolean) => void;
  error?: string;
  children?: ReactNode;
}) {
  const errorId = `${id}-error`;
  return (
    <fieldset className={styles.group} aria-describedby={error ? errorId : undefined}>
      <legend>{legend} — select all that apply</legend>
      {choices.map((choice, index) => (
        <label key={choice.value} className={styles.choice}>
          <input
            type="checkbox"
            id={index === 0 ? id : `${id}-${index}`}
            value={choice.value}
            checked={checked.includes(choice.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            onChange={(event) => onToggle(choice.value, event.target.checked)}
          />
          {choice.label}
        </label>
      ))}
      {error ? (
        <p id={errorId} className={styles.error}>
          {error}
        </p>
      ) : null}
      {children}
    </fieldset>
  );
}

function enumChoices(values: readonly string[]): Choice[] {
  return values.map((value) => ({ value, label: humanize(value) }));
}

function problemText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? (error.problem.detail ?? error.problem.title) : fallback;
}

/** "a.b[2].c" -> ["a.b[2].c", "a.b[2]", "a.b", "a"]: the nearest control that exists wins. */
function pathAndParents(path: string): string[] {
  const out: string[] = [];
  let current = path;
  while (current) {
    out.push(current);
    const cut = Math.max(current.lastIndexOf('.'), current.lastIndexOf('['));
    current = cut > 0 ? current.slice(0, cut) : '';
  }
  return out;
}

/**
 * One NERIS module (smoke alarm, fire alarm, ...) rendered from its compiled sub-schema: a union
 * is a radio choice of its discriminator values followed by the chosen branch's fields, an enum
 * a select, a list of enums a checkbox group, a boolean yes/no/unknown, numbers and text inputs.
 * Save sends only what was entered; a 400's field errors land inline and focus moves to the first.
 */
export function NerisModuleEditor({
  module,
  schema,
  stored,
  required,
  locked,
  onSave,
}: {
  module: string;
  schema: NerisModuleSchema;
  stored: unknown;
  required: boolean;
  locked: boolean;
  /** PUTs `{value}` and resolves to the value the server stored. */
  onSave: (value: JsonRecord) => Promise<unknown>;
}) {
  const defs: Defs = schema.defs;
  const title = humanize(module);
  const [draft, setDraft] = useState<unknown>(stored ?? {});
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [focusTick, setFocusTick] = useState(0);
  const summaryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (focusTick === 0) return;
    for (const error of errors) {
      for (const path of pathAndParents(error.field)) {
        const element = document.getElementById(controlId(module, path));
        if (element) {
          element.focus();
          return;
        }
      }
    }
    summaryRef.current?.focus();
  }, [focusTick, errors, module]);

  function errorAt(path: string, alsoExact: string[] = []): string | undefined {
    const messages = errors
      .filter(
        (error) =>
          error.field === path ||
          error.field.startsWith(`${path}[`) ||
          alsoExact.includes(error.field),
      )
      .map((error) => error.message);
    return messages.length > 0 ? messages.join('; ') : undefined;
  }

  async function save() {
    const value = asRecord(pruneValue(defs, schema.node, draft)) ?? {};
    setSaving(true);
    setFormError(null);
    try {
      const saved = await onSave(value);
      setDraft(saved ?? value);
      setErrors([]);
      setStatus(`${title} saved.`);
    } catch (error) {
      const fieldErrors = fieldErrorsFromUnknown(error);
      if (fieldErrors.length > 0) {
        setErrors(fieldErrors);
        setFocusTick((tick) => tick + 1);
        setStatus(`${title} was not saved: ${fieldErrors.length} to fix.`);
        return;
      }
      const detail = problemText(error, `Unable to save the ${title.toLowerCase()}.`);
      setFormError(detail);
      setStatus(detail);
    } finally {
      setSaving(false);
    }
  }

  function renderFields(
    node: Extract<SchemaNode, { k: 'obj' }>,
    value: unknown,
    set: (next: JsonRecord) => void,
    path: string,
    skip?: string,
  ): ReactNode[] {
    const record = asRecord(value) ?? {};
    return Object.entries(node.p).flatMap(([key, child]) =>
      key === skip
        ? []
        : [
            <div key={key}>
              {renderProp(
                key,
                child,
                node.r.includes(key),
                record[key],
                (next) => set({ ...record, [key]: next }),
                path ? `${path}.${key}` : key,
              )}
            </div>,
          ],
    );
  }

  function renderProp(
    key: string,
    node: SchemaNode,
    isRequired: boolean,
    value: unknown,
    set: (next: unknown) => void,
    path: string,
  ): ReactNode {
    const resolved = resolveNode(defs, node);
    const label = `${humanize(key)}${isRequired ? ' (required)' : ''}`;
    const id = controlId(module, path);

    if (resolved.k === 'union') {
      const tagKey = resolved.d ?? 'type';
      const choices = unionChoices(defs, resolved);
      const record = asRecord(value) ?? {};
      const tag = typeof record[tagKey] === 'string' ? record[tagKey] : '';
      const chosen = choices.find((choice) => choice.tag === tag);
      return (
        <ChoiceGroup
          id={id}
          legend={label}
          choices={choices.map((choice) => ({ value: choice.tag, label: humanize(choice.tag) }))}
          selected={tag}
          error={errorAt(path, [`${path}.${tagKey}`])}
          onSelect={(next) => {
            const sameBranch = choices.find((choice) => choice.tag === next)?.option;
            set(sameBranch === chosen?.option ? { ...record, [tagKey]: next } : { [tagKey]: next });
          }}
        >
          {chosen ? renderFields(chosen.option, record, set, path, tagKey) : null}
        </ChoiceGroup>
      );
    }

    if (resolved.k === 'obj') {
      return (
        <fieldset className={styles.group}>
          <legend>{label}</legend>
          {renderFields(resolved, value, set, path)}
        </fieldset>
      );
    }

    if (resolved.k === 'arr') {
      const list = Array.isArray(value) ? value : [];
      const item = resolveNode(defs, resolved.i);
      if (item.k === 'enum') {
        return (
          <CheckGroup
            id={id}
            legend={label}
            choices={enumChoices(item.v)}
            checked={list.filter((entry): entry is string => typeof entry === 'string')}
            error={errorAt(path)}
            onToggle={(choice, on) =>
              set(on ? [...list, choice] : list.filter((entry) => entry !== choice))
            }
          />
        );
      }
      // A list of objects keyed by an enum `type` (e.g. suppression system + full/partial):
      // tick each type, then fill that entry's other fields.
      const keyNode = item.k === 'obj' && item.p.type ? resolveNode(defs, item.p.type) : undefined;
      if (item.k === 'obj' && keyNode?.k === 'enum') {
        const entries = list.map((entry) => asRecord(entry) ?? {});
        return (
          <CheckGroup
            id={id}
            legend={label}
            choices={enumChoices(keyNode.v)}
            checked={entries.flatMap((entry) =>
              typeof entry.type === 'string' ? [entry.type] : [],
            )}
            error={errorAt(path)}
            onToggle={(choice, on) =>
              set(
                on
                  ? [...entries, { type: choice }]
                  : entries.filter((entry) => entry.type !== choice),
              )
            }
          >
            {entries.map((entry, index) =>
              Object.keys(item.p).some((prop) => prop !== 'type') ? (
                <fieldset key={String(entry.type)} className={styles.group}>
                  <legend>{humanize(String(entry.type))}</legend>
                  {renderFields(
                    item,
                    entry,
                    (next) => set(entries.map((old, at) => (at === index ? next : old))),
                    `${path}[${index}]`,
                    'type',
                  )}
                </fieldset>
              ) : null,
            )}
          </CheckGroup>
        );
      }
      return <p>{label}: not editable here.</p>;
    }

    if (resolved.k === 'enum') {
      return (
        <Select
          id={id}
          label={label}
          value={typeof value === 'string' ? value : ''}
          error={errorAt(path)}
          aria-required={isRequired || undefined}
          onChange={(event) => set(event.target.value || undefined)}
        >
          <option value="">{isRequired ? 'Choose one' : 'Not recorded'}</option>
          {enumChoices(resolved.v).map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </Select>
      );
    }

    if (resolved.k === 'bool') {
      return (
        <ChoiceGroup
          id={id}
          legend={label}
          choices={[
            { value: 'true', label: 'Yes' },
            { value: 'false', label: 'No' },
            { value: '', label: 'Unknown' },
          ]}
          selected={typeof value === 'boolean' ? String(value) : ''}
          error={errorAt(path)}
          onSelect={(next) => set(next === '' ? undefined : next === 'true')}
        />
      );
    }

    if (resolved.k === 'int' || resolved.k === 'num') {
      return (
        <TextInput
          id={id}
          label={label}
          type="number"
          inputMode={resolved.k === 'int' ? 'numeric' : 'decimal'}
          step={resolved.k === 'int' ? 1 : 'any'}
          min={0}
          value={typeof value === 'number' ? String(value) : ''}
          error={errorAt(path)}
          aria-required={isRequired || undefined}
          onChange={(event) =>
            set(event.target.value === '' ? undefined : Number(event.target.value))
          }
        />
      );
    }

    if (resolved.k === 'str') {
      return (
        <TextInput
          id={id}
          label={label}
          value={typeof value === 'string' ? value : ''}
          error={errorAt(path)}
          aria-required={isRequired || undefined}
          onChange={(event) => set(event.target.value)}
        />
      );
    }

    return null;
  }

  const root = resolveNode(defs, schema.node);
  const headingId = `module-${module}`;

  return (
    <section className={styles.editor} aria-labelledby={headingId}>
      <h3 id={headingId} tabIndex={-1}>
        {title}
      </h3>
      <p>
        <StatusChip status={stored ? 'ok' : required ? 'warning' : 'neutral'}>
          {stored ? 'Recorded' : 'Not recorded yet'}
        </StatusChip>
        {required ? ' Required for this incident type.' : null}
      </p>
      {errors.length > 0 ? (
        <div ref={summaryRef} tabIndex={-1} className={styles.summary}>
          <p>
            {errors.length === 1 ? '1 thing' : `${errors.length} things`} to fix before this saves:
          </p>
          <ul>
            {errors.map((error) => (
              <li key={`${error.field}-${error.message}`}>
                {humanizePath(error.field)} {error.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {formError ? <p role="alert">{formError}</p> : null}
      <fieldset className={styles.bare} disabled={locked}>
        <legend className="visually-hidden">{title} details</legend>
        {root.k === 'obj'
          ? renderFields(root, draft, setDraft, '')
          : renderProp(module, root, true, draft, setDraft, '')}
      </fieldset>
      <div className={styles.actions}>
        <Button type="button" loading={saving} disabled={locked} onClick={() => void save()}>
          Save {title.toLowerCase()}
        </Button>
      </div>
      <p className="visually-hidden" aria-live="polite">
        {status}
      </p>
    </section>
  );
}
