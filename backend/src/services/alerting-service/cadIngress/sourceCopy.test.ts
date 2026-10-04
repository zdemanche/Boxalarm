import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { SQSEvent } from 'aws-lambda';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import {
  loadCadSource,
  parseRecipientLocalPart,
  parseSourceKeyId,
  toCadSource,
} from './sourceCopy.js';

const SOURCE = {
  sourceId: 'county',
  label: 'County CAD',
  enabled: true,
  email: { allowedSenders: ['CAD.County.gov'], recipientToken: 'k3j9x2m4p7q8' },
  webhook: { keyId: 'nichols-fd.county', secretName: 'boxalarm-dev-cad-webhook/nichols-fd/county' },
  parser: { version: 2, fields: { address: { label: 'ADDR' } } },
};

describe('parseSourceKeyId', () => {
  it('splits {deptId}.{sourceId}', () => {
    expect(parseSourceKeyId('nichols-fd.county')).toEqual({
      deptId: 'nichols-fd',
      sourceId: 'county',
    });
  });

  it.each([undefined, '', 'county', '.county', 'nichols#fd.county', 'nichols-fd.County!'])(
    'refuses %s',
    (keyId) => {
      expect(parseSourceKeyId(keyId)).toBeUndefined();
    },
  );
});

describe('parseRecipientLocalPart', () => {
  it('reads dispatch+{deptId}.{sourceId}.{token}', () => {
    expect(parseRecipientLocalPart('dispatch+nichols-fd.county.k3j9x2m4p7q8')).toEqual({
      deptId: 'nichols-fd',
      sourceId: 'county',
      token: 'k3j9x2m4p7q8',
    });
  });

  it.each(['dispatch', 'dispatch+nichols-fd.county', 'dispatch+nichols-fd.county.short'])(
    'refuses %s',
    (local) => {
      expect(parseRecipientLocalPart(local)).toBeUndefined();
    },
  );
});

describe('toCadSource', () => {
  it('lower-cases senders and keeps a valid template', () => {
    expect(toCadSource(SOURCE)).toMatchObject({
      email: { allowedSenders: ['cad.county.gov'] },
      parser: { version: 2 },
    });
  });

  it('drops an invalid stored template (the source still pages, as RAW)', () => {
    const source = toCadSource({ ...SOURCE, parser: { version: 2, fields: { address: {} } } });
    expect(source?.parser).toBeUndefined();
    expect(source?.sourceId).toBe('county');
  });

  it('refuses a malformed source id', () => {
    expect(toCadSource({ ...SOURCE, sourceId: 'x#y' })).toBeUndefined();
  });
});

describe('loadCadSource', () => {
  const dept = toVerifiedDeptId({ deptId: 'nichols-fd' });
  function client(item: unknown) {
    return {
      send: vi.fn().mockResolvedValue({ Item: item }),
    } as unknown as DynamoDBDocumentClient;
  }

  it('returns the enabled source from the department copy', async () => {
    const send = vi.fn().mockResolvedValue({ Item: { sources: [SOURCE] } });
    const c = { send } as unknown as DynamoDBDocumentClient;
    expect((await loadCadSource(c, 't', dept, 'county'))?.label).toBe('County CAD');
    expect((send.mock.calls[0]?.[0] as PutCommand).input).toMatchObject({
      Key: { pk: 'DEPT#nichols-fd#CAD_INGRESS', sk: 'METADATA' },
    });
  });

  it('treats a disabled or unknown source as none', async () => {
    expect(
      await loadCadSource(
        client({ sources: [{ ...SOURCE, enabled: false }] }),
        't',
        dept,
        'county',
      ),
    ).toBeUndefined();
    expect(await loadCadSource(client(undefined), 't', dept, 'county')).toBeUndefined();
  });
});

describe('sourceCopyHandler', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    vi.resetModules();
    process.env.ALERTING_TABLE_NAME = 'alerting';
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  function event(payload: Record<string, unknown>): SQSEvent {
    return {
      Records: [
        {
          messageId: 'm-1',
          body: JSON.stringify({
            detail: {
              eventType: 'platform.config.updated',
              eventTime: '2026-09-30T12:00:00.000Z',
              payload,
            },
          }),
        },
      ],
    } as unknown as SQSEvent;
  }

  async function load(send: ReturnType<typeof vi.fn>) {
    vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../eligibility/dynamoClient.js')>()),
      createDynamoClient: () => ({ send }) as unknown as DynamoDBDocumentClient,
    }));
    return (await import('./sourceCopyHandler.js')).handler;
  }

  it('replaces the copy with the validated sources, version-guarded', async () => {
    const send = vi.fn().mockResolvedValue({});
    const handler = await load(send);
    const result = await handler(
      event({
        configType: 'CAD_INGRESS',
        deptId: 'nichols-fd',
        version: 7,
        value: { sources: [SOURCE, { sourceId: 'BAD ID' }] },
      }),
    );
    expect(result.batchItemFailures).toEqual([]);
    const put = (send.mock.calls[0]?.[0] as PutCommand).input;
    expect(put.Item).toMatchObject({
      pk: 'DEPT#nichols-fd#CAD_INGRESS',
      sk: 'METADATA',
      entityType: 'CAD_INGRESS_COPY',
      sourceVersion: 7,
    });
    expect(put.Item?.sources).toHaveLength(1);
    expect(put.ConditionExpression).toContain('sourceVersion < :version');
  });

  it('ignores other config types', async () => {
    const send = vi.fn();
    const handler = await load(send);
    await handler(event({ configType: 'ALERT_RULES', deptId: 'd', version: 1, value: {} }));
    expect(send).not.toHaveBeenCalled();
  });

  it('acknowledges a stale (older) version without rewriting', async () => {
    const send = vi
      .fn()
      .mockRejectedValue(new ConditionalCheckFailedException({ message: 'x', $metadata: {} }));
    const handler = await load(send);
    const result = await handler(
      event({ configType: 'CAD_INGRESS', deptId: 'd', version: 1, value: { sources: [] } }),
    );
    expect(result.batchItemFailures).toEqual([]);
  });

  it('fails the record (for retry, then the alarmed DLQ) on a malformed payload or write error', async () => {
    const send = vi.fn().mockRejectedValue(new Error('throttled'));
    const handler = await load(send);
    expect(
      (await handler(event({ configType: 'CAD_INGRESS', deptId: 'd', version: 1, value: {} })))
        .batchItemFailures,
    ).toEqual([{ itemIdentifier: 'm-1' }]);
    expect(
      (
        await handler(
          event({ configType: 'CAD_INGRESS', deptId: 'd', version: 2, value: { sources: [] } }),
        )
      ).batchItemFailures,
    ).toEqual([{ itemIdentifier: 'm-1' }]);
  });
});
