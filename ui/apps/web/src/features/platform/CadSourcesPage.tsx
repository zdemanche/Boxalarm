import { useEffect, useId, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../auth/AuthContext';
import { ApiError } from '../../lib/apiClient';
import { ApiForbiddenGate } from '../../components/ApiForbiddenGate';
import {
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  Dialog,
  PageHeader,
  Select,
  Skeleton,
  TextInput,
  Textarea,
} from '../../components/ui';
import {
  getCadSources,
  putCadSources,
  revokePreviousCadWebhookKey,
  rotateCadWebhookKey,
  testParseCad,
} from './api';
import {
  CAD_FIELDS,
  type CadField,
  type CadParserFields,
  type CadSourceInput,
  type CadSourceView,
  type CadTestParseResult,
  type RotatedWebhookKey,
} from './types';

const QUERY_KEY = ['platform', 'cad-sources'];

const FIELD_LABELS: Record<CadField, string> = {
  incidentNumber: 'Incident number',
  dispatchTime: 'Dispatch time',
  incidentType: 'Call type',
  address: 'Address (required)',
  crossStreets: 'Cross streets',
  town: 'Town',
  units: 'Units',
  narrative: 'Narrative',
};

const RAW_REASONS: Record<string, string> = {
  NO_ADDRESS: 'the template did not find the address',
  NO_TEMPLATE: 'this source has no template',
  EMPTY: 'the text is empty',
  TIMEOUT:
    'the template took too long - a regular expression is too complex; simplify it (live dispatches would page as raw text too)',
  ERROR: 'the template failed to run',
};

type RuleMode = 'none' | 'label' | 'pattern';

interface RuleDraft {
  mode: RuleMode;
  value: string;
}

interface SourceDraft {
  /** True once saved: the id is then fixed (it is in the email address and the key id). */
  saved: boolean;
  sourceId: string;
  label: string;
  enabled: boolean;
  emailEnabled: boolean;
  sendersText: string;
  webhookEnabled: boolean;
  rules: Record<CadField, RuleDraft>;
  view: CadSourceView | null;
}

function emptyRules(): Record<CadField, RuleDraft> {
  return Object.fromEntries(CAD_FIELDS.map((f) => [f, { mode: 'none', value: '' }])) as Record<
    CadField,
    RuleDraft
  >;
}

function toDraft(view: CadSourceView): SourceDraft {
  const rules = emptyRules();
  for (const field of CAD_FIELDS) {
    const rule = view.parser?.fields[field];
    if (rule && 'label' in rule) rules[field] = { mode: 'label', value: rule.label };
    if (rule && 'pattern' in rule) rules[field] = { mode: 'pattern', value: rule.pattern };
  }
  return {
    saved: true,
    sourceId: view.sourceId,
    label: view.label,
    enabled: view.enabled,
    emailEnabled: view.emailEnabled,
    sendersText: view.allowedSenders.join('\n'),
    webhookEnabled: view.webhookEnabled,
    rules,
    view,
  };
}

function newDraft(): SourceDraft {
  return {
    saved: false,
    sourceId: '',
    label: '',
    enabled: true,
    emailEnabled: false,
    sendersText: '',
    webhookEnabled: false,
    rules: emptyRules(),
    view: null,
  };
}

function parserFields(draft: SourceDraft): CadParserFields {
  const fields: CadParserFields = {};
  for (const field of CAD_FIELDS) {
    const rule = draft.rules[field];
    if (rule.mode === 'label' && rule.value.trim()) fields[field] = { label: rule.value.trim() };
    if (rule.mode === 'pattern' && rule.value) fields[field] = { pattern: rule.value };
  }
  return fields;
}

function toInput(draft: SourceDraft): CadSourceInput {
  const fields = parserFields(draft);
  return {
    sourceId: draft.sourceId.trim(),
    label: draft.label.trim(),
    enabled: draft.enabled,
    emailEnabled: draft.emailEnabled,
    allowedSenders: draft.sendersText
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean),
    webhookEnabled: draft.webhookEnabled,
    ...(Object.keys(fields).length > 0 ? { parser: { fields } } : {}),
  };
}

/** Field errors from a 400: the backend sends `{ field, detail }` or `{ field, message }`. */
function fieldErrorsOf(error: unknown): { field: string; message: string }[] {
  if (!(error instanceof ApiError) || !Array.isArray(error.problem.errors)) return [];
  return error.problem.errors.flatMap((item: unknown) => {
    const record = item as { field?: unknown; message?: unknown; detail?: unknown };
    const message = typeof record.message === 'string' ? record.message : record.detail;
    return typeof record.field === 'string' && typeof message === 'string'
      ? [{ field: record.field, message }]
      : [];
  });
}

export function CadSourcesPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: QUERY_KEY, queryFn: () => getCadSources(auth) });
  const [drafts, setDrafts] = useState<SourceDraft[]>([]);
  const [saveError, setSaveError] = useState<unknown>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  useEffect(() => {
    if (query.data) setDrafts(query.data.sources.map(toDraft));
  }, [query.data]);

  const save = useMutation({
    mutationFn: () => putCadSources(auth, drafts.map(toInput), query.data?.version ?? null),
    onSuccess: (saved) => {
      setSaveError(null);
      setSaveMessage('CAD sources saved. Ingress picks up the change within a minute.');
      queryClient.setQueryData(QUERY_KEY, saved);
    },
    onError: async (error: unknown) => {
      setSaveMessage(null);
      setSaveError(error);
      if (error instanceof ApiError && error.problem.status === 409) {
        await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      }
    },
  });

  function update(index: number, patch: Partial<SourceDraft>) {
    setDrafts((current) => current.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setSaveMessage(null);
    save.mutate();
  }

  const errors = fieldErrorsOf(saveError);

  return (
    <main id="main-content">
      <PageHeader
        title="CAD sources"
        breadcrumbs={[{ label: 'Settings', to: '/settings' }, { label: 'CAD sources' }]}
      />
      <Card title="How CAD dispatches reach the app">
        <p>
          A CAD system can page the department by <strong>email</strong> (to the source&apos;s own
          address, from an allowed sender whose mail passes SPF and DKIM) or by a{' '}
          <strong>signed webhook</strong>. Anything that fails those checks is dropped and alarmed -
          it never pages. A message that passes but that the template cannot read still pages, as
          raw text with the address &quot;SEE DISPATCH TEXT&quot;, flagged VERIFY.
        </p>
        <p>Radio tone-out stays the page of record alongside the app.</p>
        {query.data?.webhookUrl ? (
          <p>
            Webhook address: <code>{query.data.webhookUrl}</code>
          </p>
        ) : null}
        {query.data && !query.data.emailDomain ? (
          <p>Email ingress is not set up for this deployment yet; only the webhook is available.</p>
        ) : null}
      </Card>

      {query.isLoading ? (
        <Skeleton lines={4} />
      ) : query.error ? (
        <ApiForbiddenGate error={query.error} embedded>
          <p role="alert">Unable to load the CAD sources.</p>
        </ApiForbiddenGate>
      ) : (
        <form onSubmit={handleSubmit} noValidate>
          {drafts.length === 0 ? <p>No CAD sources yet.</p> : null}
          {drafts.map((draft, index) => (
            <SourceEditor
              key={draft.saved ? draft.sourceId : `new-${index}`}
              draft={draft}
              index={index}
              errors={errors.filter((e) => e.field.startsWith(`sources[${index}]`))}
              onChange={(patch) => update(index, patch)}
              onRemove={() => setDrafts((current) => current.filter((_, i) => i !== index))}
              emailDomainConfigured={Boolean(query.data?.emailDomain)}
            />
          ))}
          <div style={{ display: 'flex', gap: 'var(--bx-space-sm)', flexWrap: 'wrap' }}>
            <Button
              type="button"
              variant="secondary"
              onClick={() => setDrafts((current) => [...current, newDraft()])}
            >
              Add CAD source
            </Button>
            <Button type="submit" loading={save.isPending}>
              Save CAD sources
            </Button>
          </div>
          {saveError instanceof ApiError && saveError.problem.status === 403 ? (
            <ApiForbiddenGate error={saveError} embedded>
              <span />
            </ApiForbiddenGate>
          ) : saveError instanceof ApiError && saveError.problem.status === 409 ? (
            <p role="alert">
              Someone else changed the CAD sources. The latest version is shown - review and save
              again.
            </p>
          ) : saveError ? (
            <div role="alert">
              <p>The CAD sources were not saved.</p>
              {errors.length > 0 ? (
                <ul>
                  {errors.map((e) => (
                    <li key={`${e.field}-${e.message}`}>
                      <code>{e.field}</code>: {e.message}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
          {saveMessage ? <p role="status">{saveMessage}</p> : null}
        </form>
      )}
    </main>
  );
}

function SourceEditor({
  draft,
  index,
  errors,
  onChange,
  onRemove,
  emailDomainConfigured,
}: {
  draft: SourceDraft;
  index: number;
  errors: { field: string; message: string }[];
  onChange: (patch: Partial<SourceDraft>) => void;
  onRemove: () => void;
  emailDomainConfigured: boolean;
}) {
  const errorFor = (suffix: string) =>
    errors.find((e) => e.field === `sources[${index}].${suffix}`)?.message;
  const title = draft.label.trim() || draft.sourceId || `New source ${index + 1}`;

  return (
    <Card title={title}>
      <div style={{ display: 'grid', gap: 'var(--bx-space-sm)', maxWidth: 640 }}>
        <TextInput
          label="Name"
          value={draft.label}
          onChange={(e) => onChange({ label: e.target.value })}
          error={errorFor('label')}
          required
        />
        <TextInput
          label="Source id"
          help={
            draft.saved
              ? 'Fixed once saved: it is part of the email address and the webhook key id.'
              : 'Lower-case letters, digits and dashes, e.g. county-cad.'
          }
          value={draft.sourceId}
          onChange={(e) => onChange({ sourceId: e.target.value })}
          readOnly={draft.saved}
          error={errorFor('sourceId')}
          required
        />
        <Checkbox
          label="Enabled (a disabled source never pages)"
          checked={draft.enabled}
          onCheckedChange={(checked) => onChange({ enabled: checked })}
        />

        <fieldset>
          <legend>Email</legend>
          <Checkbox
            label="Accept dispatch email for this source"
            checked={draft.emailEnabled}
            onCheckedChange={(checked) => onChange({ emailEnabled: checked })}
          />
          <Textarea
            label="Allowed senders"
            help="One per line: a domain (cad.county.gov) or an address (dispatch@cad.county.gov). The From address and every DKIM signing domain must be on this list."
            rows={3}
            value={draft.sendersText}
            onChange={(e) => onChange({ sendersText: e.target.value })}
            error={
              errors.find((e) => e.field.startsWith(`sources[${index}].allowedSenders`))?.message
            }
          />
          {draft.view?.emailAddress && draft.emailEnabled ? (
            <p>
              Send dispatches to: <code>{draft.view.emailAddress}</code>
            </p>
          ) : draft.emailEnabled ? (
            <p>
              {emailDomainConfigured
                ? 'The address is shown after you save.'
                : 'Email ingress is not set up for this deployment.'}
            </p>
          ) : null}
        </fieldset>

        <fieldset>
          <legend>Webhook</legend>
          <Checkbox
            label="Accept signed webhook requests for this source"
            checked={draft.webhookEnabled}
            onCheckedChange={(checked) => onChange({ webhookEnabled: checked })}
          />
          {draft.saved ? <WebhookKey draft={draft} /> : <p>Save the source to create its key.</p>}
        </fieldset>

        {draft.rules.incidentNumber.mode === 'none' || !draft.rules.incidentNumber.value.trim() ? (
          <p role="note">
            <strong>Warning:</strong> no incident number rule. Dispatches from this source are told
            apart by their text only, so an identical resend within 10 minutes is dropped and CAD
            updates to a call page as new calls. Add an incident number rule if the CAD sends one.
          </p>
        ) : null}
        <ParserEditor draft={draft} index={index} errors={errors} onChange={onChange} />

        <Button type="button" variant="danger" onClick={onRemove} style={{ width: 'fit-content' }}>
          Remove {title}
        </Button>
      </div>
    </Card>
  );
}

function WebhookKey({ draft }: { draft: SourceDraft }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [rotated, setRotated] = useState<RotatedWebhookKey | null>(null);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revoked, setRevoked] = useState(false);
  const hasKey = Boolean(draft.view?.webhookKeyId);

  async function revoke() {
    await revokePreviousCadWebhookKey(auth, draft.sourceId);
    setRevoked(true);
  }

  async function rotate() {
    const key = await rotateCadWebhookKey(auth, draft.sourceId);
    setRotated(key);
    await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  }

  return (
    <div>
      {hasKey ? (
        <p>
          Key id <code>{draft.view?.webhookKeyId}</code>, last rotated{' '}
          {draft.view?.webhookRotatedAt
            ? new Date(draft.view.webhookRotatedAt).toLocaleString()
            : 'unknown'}
          .
        </p>
      ) : (
        <p>No key yet: the webhook refuses every request until one is created.</p>
      )}
      <Button type="button" variant="secondary" onClick={() => setConfirmOpen(true)}>
        {hasKey ? 'Rotate webhook key' : 'Create webhook key'}
      </Button>
      {hasKey ? (
        <Button type="button" variant="danger" onClick={() => setRevokeOpen(true)}>
          Revoke previous key now
        </Button>
      ) : null}
      {revoked ? <p role="status">The previous key no longer works.</p> : null}
      <ConfirmDialog
        open={revokeOpen}
        onOpenChange={setRevokeOpen}
        title={`Revoke the previous webhook key for ${draft.label}?`}
        consequence="The key replaced by the last rotation stops working within a minute, instead of 24 hours after the rotation. Do this after a leak, or once the CAD is confirmed on the current key. A CAD still signing with the old key will be refused."
        confirmLabel="Revoke previous key"
        onConfirm={revoke}
        danger
      />
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={
          hasKey
            ? `Rotate the webhook key for ${draft.label}?`
            : `Create a webhook key for ${draft.label}?`
        }
        consequence={
          hasKey
            ? 'A new key is created and shown once. The current key keeps working for 24 hours, so the CAD can be switched over without a gap; revoke it sooner if it leaked.'
            : 'A new key is created and shown once. Give it to the CAD operator to sign requests.'
        }
        confirmLabel={hasKey ? 'Rotate key' : 'Create key'}
        onConfirm={rotate}
      />
      <Dialog
        open={rotated !== null}
        onOpenChange={(open) => {
          if (!open) setRotated(null);
        }}
        title="Copy the webhook key now"
        description="This is the only time the key is shown. Store it in the CAD's configuration; Boxalarm cannot show it again."
        footer={
          <Button type="button" onClick={() => setRotated(null)}>
            I have stored the key
          </Button>
        }
      >
        {rotated ? (
          <dl>
            <dt>X-Boxalarm-Source</dt>
            <dd>
              <code>{rotated.keyId}</code>
            </dd>
            <dt>Key</dt>
            <dd>
              <code style={{ wordBreak: 'break-all' }}>{rotated.secret}</code>
            </dd>
            <dt>x-api-key</dt>
            <dd>
              <code style={{ wordBreak: 'break-all' }}>{rotated.apiKey}</code> - send it as the{' '}
              <code>x-api-key</code> header on every request. It is this source&apos;s own capacity;
              without it API Gateway refuses the request.
            </dd>
            {rotated.previousKeyExpiresAt ? (
              <>
                <dt>Previous key</dt>
                <dd>
                  Keeps working until {new Date(rotated.previousKeyExpiresAt).toLocaleString()}, or
                  until you revoke it.
                </dd>
              </>
            ) : null}
            <dt>Signature</dt>
            <dd>
              <code>
                X-Boxalarm-Signature: v1=hex(HMAC-SHA256(key, timestamp + &quot;.&quot; + body))
              </code>{' '}
              over the exact request bytes, keyed with the key text exactly as shown, with{' '}
              <code>X-Boxalarm-Timestamp</code> in Unix seconds (within 5 minutes).
            </dd>
          </dl>
        ) : null}
      </Dialog>
    </div>
  );
}

function ParserEditor({
  draft,
  index,
  errors,
  onChange,
}: {
  draft: SourceDraft;
  index: number;
  errors: { field: string; message: string }[];
  onChange: (patch: Partial<SourceDraft>) => void;
}) {
  const auth = useAuth();
  const sampleId = useId();
  const [sample, setSample] = useState('');
  const [result, setResult] = useState<CadTestParseResult | null>(null);
  const [testError, setTestError] = useState<unknown>(null);
  const test = useMutation({
    mutationFn: () => testParseCad(auth, parserFields(draft), sample),
    onSuccess: (r) => {
      setTestError(null);
      setResult(r);
    },
    onError: (error: unknown) => {
      setResult(null);
      setTestError(error);
    },
  });

  function setRule(field: CadField, patch: Partial<RuleDraft>) {
    onChange({ rules: { ...draft.rules, [field]: { ...draft.rules[field], ...patch } } });
  }

  const testErrors = fieldErrorsOf(testError);

  return (
    <fieldset>
      <legend>
        Parser template{draft.view?.parser ? ` (version ${draft.view.parser.version})` : ''}
      </legend>
      <p>
        For each field, give the line label the CAD uses (&quot;ADDRESS&quot; reads a line
        &quot;ADDRESS: 123 MAIN ST&quot;) or a regular expression whose first group is the value. A
        dispatch is read as structured only when its address is found.
      </p>
      {CAD_FIELDS.map((field) => {
        const rule = draft.rules[field];
        const fieldError = errors.find((e) =>
          e.field.startsWith(`sources[${index}].parser.fields.${field}`),
        )?.message;
        return (
          <div
            key={field}
            style={{ display: 'grid', gridTemplateColumns: 'minmax(10rem, 14rem) 1fr', gap: 8 }}
          >
            <Select
              label={`${FIELD_LABELS[field]}: read by`}
              value={rule.mode}
              onChange={(e) => setRule(field, { mode: e.target.value as RuleMode })}
            >
              <option value="none">Not used</option>
              <option value="label">Line label</option>
              <option value="pattern">Regular expression</option>
            </Select>
            <TextInput
              label={`${FIELD_LABELS[field]}: ${rule.mode === 'pattern' ? 'expression' : 'label'}`}
              value={rule.value}
              disabled={rule.mode === 'none'}
              onChange={(e) => setRule(field, { value: e.target.value })}
              error={fieldError}
            />
          </div>
        );
      })}
      <Textarea
        id={sampleId}
        label="Sample dispatch text"
        help="Paste a real dispatch to see how this template reads it. Nothing is paged."
        rows={6}
        value={sample}
        onChange={(e) => setSample(e.target.value)}
      />
      <Button
        type="button"
        variant="secondary"
        loading={test.isPending}
        onClick={() => test.mutate()}
        disabled={sample.trim().length === 0}
        style={{ width: 'fit-content' }}
      >
        Test parse
      </Button>
      <div role="status" aria-live="polite">
        {result?.status === 'PARSED' ? (
          <div>
            <p>
              <strong>Structured.</strong> This dispatch would page as:
            </p>
            <dl>
              {CAD_FIELDS.filter((f) => result.fields[f]).map((f) => (
                <div key={f}>
                  <dt>{FIELD_LABELS[f]}</dt>
                  <dd>{result.fields[f]}</dd>
                </div>
              ))}
            </dl>
          </div>
        ) : result?.status === 'RAW' ? (
          <p>
            <strong>Raw text (VERIFY).</strong> This dispatch would still page, with the address
            &quot;SEE DISPATCH TEXT&quot; and the whole text as the narrative, because{' '}
            {RAW_REASONS[result.reason] ?? result.reason}.
          </p>
        ) : null}
      </div>
      {testError ? (
        <div role="alert">
          <p>The template could not be tested.</p>
          {testErrors.length > 0 ? (
            <ul>
              {testErrors.map((e) => (
                <li key={`${e.field}-${e.message}`}>
                  <code>{e.field}</code>: {e.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </fieldset>
  );
}
