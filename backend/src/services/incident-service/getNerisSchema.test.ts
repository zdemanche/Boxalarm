import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decision } from '@aws-sdk/client-verifiedpermissions';
import compiled from './neris/fixtures/neris-api-1.5.1.json' with { type: 'json' };
import { MEMBER_AUTH, buildIncidentEvent } from './testEvents.js';

const { vpSend, getActiveSchemaVersion, getSchemaVersion, getNerisApiSchemaDocument } = vi.hoisted(
  () => ({
    vpSend: vi.fn(),
    getActiveSchemaVersion: vi.fn(),
    getSchemaVersion: vi.fn(),
    getNerisApiSchemaDocument: vi.fn(),
  }),
);

vi.mock('@aws-sdk/client-verifiedpermissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-verifiedpermissions')>();
  return {
    ...actual,
    VerifiedPermissionsClient: vi.fn().mockImplementation(() => ({ send: vpSend })),
  };
});
vi.mock('./schemaVersion/repository.js', () => ({
  createSchemaVersionRepository: () => ({ getActiveSchemaVersion, getSchemaVersion }),
}));
vi.mock('./schemaVersion/s3Schema.js', () => ({
  getNerisApiSchemaDocument,
}));
vi.mock('./repository.js', () => ({
  getDocumentClient: () => ({}),
  getTableName: () => 'incident-table',
}));

process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';
process.env.NERIS_SCHEMA_BUCKET_NAME = 'bucket';

import { handler } from './getNerisSchema.js';

async function call(
  version?: string,
): Promise<{ statusCode: number; json: Record<string, unknown> }> {
  const event = buildIncidentEvent({
    method: 'GET',
    routeKey: 'GET /api/v1/incidents/neris-schema',
    auth: MEMBER_AUTH,
  });
  const result = (await handler(
    version === undefined ? event : { ...event, queryStringParameters: { version } },
  )) as { statusCode: number; body: string };
  return {
    statusCode: result.statusCode,
    json: JSON.parse(result.body) as Record<string, unknown>,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vpSend.mockResolvedValue({ decision: Decision.ALLOW });
  getNerisApiSchemaDocument.mockResolvedValue(compiled);
});

describe('GET /incidents/neris-schema', () => {
  it('serves NERIS TypeIncidentValue with labels and the editable module sub-schemas', async () => {
    getActiveSchemaVersion.mockResolvedValue({
      version: '2026.2+neris-1.5.1',
      nerisApiS3Key: 'neris-schema/2026.2+neris-1.5.1/neris-api.json',
    });
    const { statusCode, json } = await call();
    expect(statusCode).toBe(200);
    expect(json.apiVersion).toBe('1.5.1');
    expect(json.incidentTypes).toContainEqual({
      value: 'FIRE||STRUCTURE_FIRE||CHIMNEY_FIRE',
      label: 'Fire › Structure fire › Chimney fire',
    });
    expect((json.incidentTypes as unknown[]).length).toBe(140);
    expect(Object.keys(json.modules as object).sort()).toEqual([
      'cooking_fire_suppression',
      'fire_alarm',
      'fire_suppression',
      'other_alarm',
      'smoke_alarm',
    ]);
    const smoke = (json.modules as Record<string, { defs: Record<string, unknown> }>).smoke_alarm!;
    expect(Object.keys(smoke.defs)).toContain('SmokeAlarmPresentPayload');
  });

  it('answers 503 until the NERIS schema has been downloaded', async () => {
    getActiveSchemaVersion.mockResolvedValue({ version: '2026.2' });
    const { statusCode, json } = await call();
    expect(statusCode).toBe(503);
    expect(json.code).toBe('NERIS_SCHEMA_UNAVAILABLE');
  });

  it("serves the report's pinned NERIS schema when asked for its version (round 2, N8)", async () => {
    getActiveSchemaVersion.mockResolvedValue({
      version: '2026.3+neris-1.6.0',
      nerisApiS3Key: 'neris-schema/2026.3+neris-1.6.0/neris-api.json',
    });
    getSchemaVersion.mockResolvedValue({
      version: '2026.2+neris-1.5.1',
      nerisApiS3Key: 'neris-schema/2026.2+neris-1.5.1/neris-api.json',
    });
    const { statusCode, json } = await call('2026.2+neris-1.5.1');
    expect(statusCode).toBe(200);
    expect(json.version).toBe('2026.2+neris-1.5.1');
    expect(getSchemaVersion).toHaveBeenCalledWith('2026.2+neris-1.5.1');
    expect(getNerisApiSchemaDocument).toHaveBeenCalledWith(
      expect.anything(),
      'bucket',
      'neris-schema/2026.2+neris-1.5.1/neris-api.json',
    );
  });

  it('falls back to ACTIVE when the pin has no NERIS schema, and refuses a malformed version', async () => {
    getActiveSchemaVersion.mockResolvedValue({
      version: '2026.3+neris-1.6.0',
      nerisApiS3Key: 'neris-schema/2026.3+neris-1.6.0/neris-api.json',
    });
    getSchemaVersion.mockResolvedValue({ version: '2026.1' });
    expect((await call('2026.1')).json.version).toBe('2026.3+neris-1.6.0');
    expect((await call('../etc')).statusCode).toBe(400);
  });
});
