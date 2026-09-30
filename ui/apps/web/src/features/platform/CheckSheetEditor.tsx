import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { ApiError, problemFieldErrors, type ProblemFieldError } from '../../lib/apiClient';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import { Button, Card, Checkbox, Skeleton, TextInput } from '../../components/ui';
import { getConfig, putConfig } from './api';
import type { ConfigResponse } from './types';

/** One row of the department's default check sheet (platform config CHECKLIST_DEFAULTS). */
export interface CheckSheetItem {
  code: string;
  label: string;
  requiresPhoto: boolean;
  /** Answered on its own in the truck check: never covered by "Mark the other N OK". */
  critical: boolean;
}

const QUERY_KEY = ['platform', 'config', 'CHECKLIST_DEFAULTS'];

function toItems(value: Record<string, unknown> | undefined): CheckSheetItem[] {
  const items = Array.isArray(value?.items) ? (value.items as Record<string, unknown>[]) : [];
  return items.map((item) => ({
    code: typeof item.code === 'string' ? item.code : '',
    label: typeof item.label === 'string' ? item.label : '',
    requiresPhoto: item.requiresPhoto === true,
    critical: item.critical === true,
  }));
}

/**
 * The code shape the server requires (platform-service config schema CHECKLIST_ITEM_CODE): the
 * truck check sends it with each defect and photo, and the photo route puts it in a storage key.
 */
export const ITEM_CODE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** A stable code from the label ("Brake air pressure" -> "BRAKE_AIR_PRESSURE"). */
export function codeFromLabel(label: string, index: number): string {
  const code = label
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return code.length > 0 ? code : `ITEM_${index + 1}`;
}

/**
 * The department's check sheet as a form, one row per item, instead of hand-edited JSON. It is
 * the sheet the truck check uses for any unit without a sheet of its own. "Critical" items
 * (brakes, SCBA pressure) must be answered one by one on the phone.
 */
export function CheckSheetEditor() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const configQuery = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async (): Promise<ConfigResponse | null> => {
      try {
        return await getConfig(auth, 'CHECKLIST_DEFAULTS');
      } catch (error) {
        if (error instanceof ApiError && error.problem.status === 404) return null;
        throw error;
      }
    },
  });

  const [items, setItems] = useState<CheckSheetItem[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<readonly ProblemFieldError[]>([]);
  const [saved, setSaved] = useState(false);
  const [codeErrors, setCodeErrors] = useState<Record<number, string>>({});
  const [forbiddenError, setForbiddenError] = useState<unknown>(null);

  useEffect(() => {
    if (configQuery.data !== undefined) setItems(toItems(configQuery.data?.value));
  }, [configQuery.data]);

  const saveMutation = useMutation({
    mutationFn: (next: CheckSheetItem[]) =>
      putConfig(auth, 'CHECKLIST_DEFAULTS', { items: next }, configQuery.data?.version),
    onSuccess: (result) => {
      setSaved(true);
      queryClient.setQueryData(QUERY_KEY, result);
    },
    onError: async (error: unknown) => {
      if (error instanceof ApiError && error.problem.status === 409) {
        setFormError(
          'Someone else changed the check sheet. Showing their version — review it and save again.',
        );
        await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
        return;
      }
      if (error instanceof ApiError && error.problem.status === 403) {
        setForbiddenError(error);
        return;
      }
      if (error instanceof ApiError) {
        setFormError(error.problem.detail ?? error.problem.title);
        if (error.problem.status === 400) setFieldErrors(problemFieldErrors(error.problem));
        return;
      }
      setFormError('Could not save. Try again.');
    },
  });

  function update(index: number, patch: Partial<CheckSheetItem>) {
    setSaved(false);
    setItems((current) => current.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setFormError(null);
    setFieldErrors([]);
    setForbiddenError(null);
    setCodeErrors({});
    const next = items
      .map((item, index) => ({
        ...item,
        label: item.label.trim(),
        code: item.code.trim() || codeFromLabel(item.label, index),
      }))
      .filter((item) => item.label.length > 0);
    if (next.length === 0) {
      setFormError('Add at least one item with a name.');
      return;
    }
    const badCodes: Record<number, string> = {};
    next.forEach((item, index) => {
      if (!ITEM_CODE.test(item.code)) {
        badCodes[index] =
          'Use letters, digits, "_", "." or "-" only, starting with a letter or digit (up to 64), e.g. BRAKE_PRESSURE. Leave it blank to make one from the name.';
      }
    });
    if (Object.keys(badCodes).length > 0) {
      setItems(next);
      setCodeErrors(badCodes);
      setFormError(
        `${Object.keys(badCodes).length === 1 ? 'One item has a code' : 'Some items have codes'} the truck check can't send. Fix the codes marked below.`,
      );
      return;
    }
    const codes = next.map((item) => item.code);
    const duplicate = codes.find((code, i) => codes.indexOf(code) !== i);
    if (duplicate) {
      setFormError(`Two items have the code ${duplicate}. Give each item its own code.`);
      return;
    }
    setItems(next);
    saveMutation.mutate(next);
  }

  return (
    <Card title="Check sheet" style={{ marginTop: 'var(--bx-space-xl)' }}>
      <p>
        The truck check for any unit that has no check sheet of its own. Mark an item critical when
        it must be looked at on its own every time (brakes, SCBA pressure): the app never includes
        it in &ldquo;Mark the other items OK&rdquo;.
      </p>
      {configQuery.isLoading ? (
        <Skeleton lines={3} />
      ) : configQuery.error ? (
        <ApiForbiddenGate error={configQuery.error} embedded>
          <p role="alert">Unable to load the check sheet.</p>
        </ApiForbiddenGate>
      ) : (
        <form
          aria-label="Check sheet"
          onSubmit={handleSubmit}
          style={{ display: 'grid', gap: 'var(--bx-space-md)', maxWidth: 720 }}
        >
          {items.length === 0 ? <p>No items yet. Add the first one.</p> : null}
          <ol style={{ display: 'grid', gap: 'var(--bx-space-md)', paddingLeft: 0, margin: 0 }}>
            {items.map((item, index) => (
              <li
                key={index}
                style={{
                  listStyle: 'none',
                  display: 'grid',
                  gap: 'var(--bx-space-sm)',
                  paddingBottom: 'var(--bx-space-md)',
                  borderBottom: '1px solid var(--bx-border-decorative)',
                }}
              >
                <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 8 }}>
                  <legend style={{ fontWeight: 600 }}>
                    Item {index + 1}
                    {item.label ? `: ${item.label}` : ''}
                  </legend>
                  <TextInput
                    label="What to check"
                    value={item.label}
                    onChange={(e) => update(index, { label: e.target.value })}
                  />
                  <TextInput
                    label="Code"
                    optional
                    help="Leave blank to make one from the name. Changing it later starts a new history for the item."
                    value={item.code}
                    error={codeErrors[index]}
                    onChange={(e) => update(index, { code: e.target.value })}
                  />
                  <Checkbox
                    label="Needs a photo"
                    checked={item.requiresPhoto}
                    onCheckedChange={(checked) => update(index, { requiresPhoto: checked })}
                  />
                  <Checkbox
                    label="Critical — must be answered on its own"
                    checked={item.critical}
                    onCheckedChange={(checked) => update(index, { critical: checked })}
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    aria-label={`Remove item ${index + 1}${item.label ? `, ${item.label}` : ''}`}
                    onClick={() => {
                      setSaved(false);
                      setItems((current) => current.filter((_, i) => i !== index));
                    }}
                    style={{ width: 'fit-content' }}
                  >
                    Remove
                  </Button>
                </fieldset>
              </li>
            ))}
          </ol>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setSaved(false);
              setItems((current) => [
                ...current,
                { code: '', label: '', requiresPhoto: false, critical: false },
              ]);
            }}
            style={{ width: 'fit-content' }}
          >
            Add item
          </Button>
          {forbiddenError ? (
            <ApiForbiddenGate error={forbiddenError} embedded>
              <p role="alert">Could not save the check sheet.</p>
            </ApiForbiddenGate>
          ) : null}
          {formError ? (
            <div role="alert">
              <p>{formError}</p>
              {fieldErrors.length > 0 ? (
                <ul>
                  {fieldErrors.map((fieldError) => (
                    <li key={`${fieldError.field}:${fieldError.message}`}>
                      <code>{fieldError.field}</code> {fieldError.message}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          <p role="status">{saved ? 'Check sheet saved.' : ''}</p>
          <Button type="submit" loading={saveMutation.isPending} style={{ width: 'fit-content' }}>
            Save check sheet
          </Button>
        </form>
      )}
    </Card>
  );
}
