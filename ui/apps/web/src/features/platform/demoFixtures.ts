import type {
  CadField,
  CadParserFields,
  CadSourceInput,
  CadSourceView,
  CadSourcesResponse,
  CadTestParseResult,
} from './types';
import { CAD_FIELDS } from './types';

// Every value here is obviously fake: .invalid hosts, demo-fd ids, demo-key-… secrets. Nothing
// resembles a real endpoint or credential.
const DEMO_WEBHOOK_BASE = 'https://demo.invalid/api/v1/alerting/ingress/cad-webhook';
const DEMO_EMAIL_DOMAIN = 'cad.demo.boxalarm.invalid';
const DEMO_SECRET = `demo-key-${'0123456789abcdef'.repeat(3)}not-a-real-key`;
const DEMO_API_KEY = 'demo-api-key-0123456789abcdef';

let version = 3;
let emailToken = 0;

function demoEmailAddress(sourceId: string): string {
  emailToken += 1;
  return `dispatch+demo-fd.${sourceId}.demotoken${String(emailToken).padStart(7, '0')}@${DEMO_EMAIL_DOMAIN}`;
}

let sources: CadSourceView[] = [
  {
    sourceId: 'county',
    label: 'County CAD (demo)',
    enabled: true,
    emailEnabled: true,
    allowedSenders: ['cad.county.invalid'],
    emailAddress: demoEmailAddress('county'),
    webhookEnabled: true,
    webhookKeyId: 'demo-fd.county',
    webhookEndpoint: `${DEMO_WEBHOOK_BASE}/demo-fd.county`,
    webhookRotatedAt: '2026-09-30T12:00:00.000Z',
    parser: {
      version: 2,
      fields: {
        incidentNumber: { label: 'INC' },
        dispatchTime: { label: 'TIME' },
        incidentType: { label: 'TYPE' },
        address: { label: 'ADDR' },
      },
    },
    timeZone: 'America/New_York',
  },
];

function response(): CadSourcesResponse {
  return {
    version,
    emailDomain: DEMO_EMAIL_DOMAIN,
    webhookUrl: DEMO_WEBHOOK_BASE,
    sources,
    warnings: [],
  };
}

function toView(input: CadSourceInput): CadSourceView {
  const existing = sources.find((s) => s.sourceId === input.sourceId);
  return {
    sourceId: input.sourceId,
    label: input.label,
    enabled: input.enabled,
    emailEnabled: input.emailEnabled,
    allowedSenders: input.allowedSenders,
    emailAddress:
      input.emailEnabled && !existing?.emailAddress
        ? demoEmailAddress(input.sourceId)
        : (existing?.emailAddress ?? null),
    webhookEnabled: input.webhookEnabled,
    webhookKeyId: existing?.webhookKeyId ?? null,
    webhookEndpoint: existing?.webhookEndpoint ?? null,
    webhookRotatedAt: existing?.webhookRotatedAt ?? null,
    parser: input.parser
      ? { version: (existing?.parser?.version ?? 0) + 1, fields: input.parser.fields }
      : null,
    ...(input.timeZone ? { timeZone: input.timeZone } : {}),
  };
}

/** A small stand-in for the backend parser: line labels and first-group patterns. */
function parseSample(fields: CadParserFields, sample: string): CadTestParseResult {
  const lines = sample.split(/\r?\n/);
  const found: Partial<Record<CadField, string>> = {};
  for (const field of CAD_FIELDS) {
    const rule = fields[field];
    if (!rule) continue;
    if ('label' in rule) {
      const prefix = `${rule.label.trim().toUpperCase()}:`;
      const line = lines.find((l) => l.trim().toUpperCase().startsWith(prefix));
      const value = line?.trim().slice(prefix.length).trim();
      if (value) found[field] = value;
    } else {
      try {
        const value = new RegExp(rule.pattern, 'm').exec(sample)?.[1];
        if (value) found[field] = value;
      } catch {
        // An invalid pattern reads nothing in the demo; the real backend 400s on save.
      }
    }
  }
  const time = found.dispatchTime?.trim();
  const resolution = time
    ? /^\d{1,2}:?\d{2}(:\d{2})?$/.test(time)
      ? { dispatchTimeResolved: new Date().toISOString() }
      : { dispatchTimeUnordered: true as const }
    : {};
  return found.address
    ? { status: 'PARSED', fields: found, ...resolution }
    : { status: 'RAW', reason: 'NO_ADDRESS', fields: found, ...resolution };
}

/**
 * Demo handlers for Settings → CAD sources (GET/PUT, test-parse, rotate/revoke key, new email
 * address), so the page works in demo mode instead of a generic load error.
 */
export function tryHandleCadSourcesDemo(
  parts: string[],
  method: string,
  body: Record<string, unknown>,
): Response | undefined {
  if (parts[0] !== 'platform' || parts[1] !== 'cad-sources') return undefined;

  if (parts.length === 2 && method === 'GET') return json(response());

  if (parts.length === 2 && method === 'PUT') {
    const input = body as unknown as { sources: CadSourceInput[]; expectedVersion?: number };
    if (input.expectedVersion !== undefined && input.expectedVersion !== version) {
      return json(
        {
          type: 'about:blank',
          title: 'Conflict',
          status: 409,
          detail: 'CAD sources were changed by someone else; reload and retry',
          traceId: 'demo',
        },
        409,
      );
    }
    sources = input.sources.map(toView);
    version += 1;
    return json(response());
  }

  if (parts[2] === 'test-parse' && method === 'POST') {
    const { fields, sample } = body as { fields?: CadParserFields; sample?: string };
    return json(parseSample(fields ?? {}, sample ?? ''));
  }

  const sourceId = decodeURIComponent(parts[2] ?? '');
  const source = sources.find((s) => s.sourceId === sourceId);
  if (!source) return json({ type: 'about:blank', title: 'Not Found', status: 404 }, 404);

  if (parts[3] === 'webhook-key' && parts.length === 4 && method === 'POST') {
    const keyId = `demo-fd.${sourceId}`;
    const hadKey = source.webhookKeyId !== null;
    source.webhookKeyId = keyId;
    source.webhookEndpoint = `${DEMO_WEBHOOK_BASE}/${keyId}`;
    source.webhookRotatedAt = new Date().toISOString();
    return json({
      keyId,
      secret: DEMO_SECRET,
      apiKey: DEMO_API_KEY,
      rotatedAt: source.webhookRotatedAt,
      previousKeyStillValid: hadKey,
      previousKeyExpiresAt: hadKey ? new Date(Date.now() + 86_400_000).toISOString() : null,
      webhookUrl: source.webhookEndpoint,
    });
  }

  if (parts[3] === 'webhook-key' && parts[4] === 'revoke-previous' && method === 'POST') {
    return json({ sourceId, previousKeyRevoked: true });
  }

  if (parts[3] === 'email-address' && method === 'POST') {
    source.emailAddress = demoEmailAddress(sourceId);
    version += 1;
    return json(response());
  }

  return undefined;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
