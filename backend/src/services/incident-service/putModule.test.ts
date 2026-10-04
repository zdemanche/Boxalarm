import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Decision } from '@aws-sdk/client-verifiedpermissions';
import compiled from './neris/fixtures/neris-api-1.5.1.json' with { type: 'json' };
import { MEMBER_AUTH, buildIncidentEvent } from './testEvents.js';

const { vpSend, getIncident, updateModule } = vi.hoisted(() => ({
  vpSend: vi.fn(),
  getIncident: vi.fn(),
  updateModule: vi.fn(),
}));

vi.mock('@aws-sdk/client-verifiedpermissions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-verifiedpermissions')>();
  return {
    ...actual,
    VerifiedPermissionsClient: vi.fn().mockImplementation(function () {
      return { send: vpSend };
    }),
  };
});
vi.mock('./repository.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./repository.js')>();
  return { ...actual, getIncidentRepository: () => ({ getIncident, updateModule }) };
});
vi.mock('./reportContext.js', () => ({
  loadSchema: () => Promise.resolve({ nerisApi: compiled }),
}));

process.env.VERIFIED_PERMISSIONS_POLICY_STORE_ID = 'ps-1';

import { handler } from './putModule.js';

const INCIDENT_ID = 'NICHOLS-4471-1798000000';

async function put(module: string, value: unknown) {
  const event = buildIncidentEvent({
    method: 'PUT',
    routeKey: 'PUT /api/v1/incidents/{incidentId}/modules/{module}',
    auth: MEMBER_AUTH,
    incidentId: INCIDENT_ID,
    body: { value },
  });
  (event.pathParameters as Record<string, string>).module = module;
  const result = (await handler(event)) as { statusCode: number; body: string };
  return {
    statusCode: result.statusCode,
    json: JSON.parse(result.body) as Record<string, unknown>,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vpSend.mockResolvedValue({ decision: Decision.ALLOW });
  getIncident.mockResolvedValue({ incidentId: INCIDENT_ID, corePayload: {} });
  updateModule.mockImplementation((_d, id: string, module: string, value: unknown) =>
    Promise.resolve({ incidentId: id, corePayload: { [module]: value } }),
  );
});

describe('PUT /incidents/{id}/modules/{module}', () => {
  it('saves a smoke alarm module reduced to the NERIS sub-schema', async () => {
    const { statusCode } = await put('smoke_alarm', {
      presence: { type: 'PRESENT', working: false, alarm_types: ['HARDWIRED'], note: 'x' },
    });
    expect(statusCode).toBe(200);
    expect(updateModule).toHaveBeenCalledWith(
      'NICHOLS',
      INCIDENT_ID,
      'smoke_alarm',
      { presence: { type: 'PRESENT', working: false, alarm_types: ['HARDWIRED'] } },
      expect.any(Number),
      expect.any(String),
    );
    expect(
      (vpSend.mock.calls[0]![0] as { input: { action: { actionId: string } } }).input.action
        .actionId,
    ).toBe('EditIncidentModule');
  });

  it('refuses a value outside the NERIS choices with field errors', async () => {
    const { statusCode, json } = await put('fire_alarm', {
      presence: { type: 'PRESENT', alarm_types: ['SPRINKLER'] },
    });
    expect(statusCode).toBe(400);
    expect(json.errors).toEqual([expect.objectContaining({ field: 'presence.alarm_types[0]' })]);
    expect(updateModule).not.toHaveBeenCalled();
  });

  it('refuses a module that is not editable, and a locked report', async () => {
    expect((await put('casualty_rescues', [])).statusCode).toBe(400);
    getIncident.mockResolvedValue({ incidentId: INCIDENT_ID, corePayload: {}, lockedAt: 5 });
    const locked = await put('other_alarm', { presence: { type: 'NOT_PRESENT' } });
    expect(locked.statusCode).toBe(409);
    expect(locked.json.code).toBe('INCIDENT_LOCKED');
  });
});
