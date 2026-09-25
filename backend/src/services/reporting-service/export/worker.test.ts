import { beforeEach, describe, expect, it, vi } from 'vitest';

const { markExportJob, buildExportTable, s3Send } = vi.hoisted(() => ({
  markExportJob: vi.fn(),
  buildExportTable: vi.fn(),
  s3Send: vi.fn(),
}));

vi.mock('../awsClients.js', () => ({
  readReportingServiceConfig: vi.fn(() => ({ tableName: 'platform-table' })),
  createDynamoDocClient: vi.fn(() => ({ send: vi.fn() })),
}));
vi.mock('../logger.js', () => ({ logError: vi.fn(), logger: { error: vi.fn() } }));
vi.mock('@boxalarm/metrics', () => ({ emitOutcomeMetric: vi.fn() }));
vi.mock('./repository.js', () => ({ markExportJob }));
vi.mock('./buildReport.js', () => ({ buildExportTable }));
vi.mock('./clients.js', () => ({
  createExportS3Client: () => ({ send: s3Send }),
  readExportsBucket: () => 'boxalarm-dev-exports-staging',
}));

import { handler } from './worker.js';

beforeEach(() => {
  vi.clearAllMocks();
  s3Send.mockResolvedValue({});
  markExportJob.mockResolvedValue(undefined);
});

describe('reporting export worker', () => {
  it('writes the rendered file and marks the job completed', async () => {
    buildExportTable.mockResolvedValue({
      title: 'Dashboard',
      headers: ['field', 'value'],
      rows: [['activeMemberCount', '4']],
    });
    await handler(
      {
        jobId: 'job-1',
        deptId: 'NICHOLS',
        report: 'dashboard',
        format: 'csv',
        params: {},
      },
      {} as never,
      () => undefined,
    );
    expect(s3Send).toHaveBeenCalledOnce();
    const put = s3Send.mock.calls[0]?.[0] as unknown as {
      input: { Bucket: string; Key: string; ContentType: string };
    };
    expect(put.input.Bucket).toBe('boxalarm-dev-exports-staging');
    expect(put.input.Key).toBe('NICHOLS/job-1/report.csv');
    expect(put.input.ContentType).toBe('text/csv');
    expect(markExportJob).toHaveBeenCalledWith(
      expect.anything(),
      'platform-table',
      expect.anything(),
      'job-1',
      'COMPLETED',
      { objectKey: 'NICHOLS/job-1/report.csv' },
    );
  });

  it('marks the job failed when rendering throws', async () => {
    buildExportTable.mockRejectedValue(new Error('missing year'));
    await handler(
      { jobId: 'job-2', deptId: 'NICHOLS', report: 'losap', format: 'pdf', params: {} },
      {} as never,
      () => undefined,
    );
    expect(markExportJob).toHaveBeenCalledWith(
      expect.anything(),
      'platform-table',
      expect.anything(),
      'job-2',
      'FAILED',
      { detail: 'missing year' },
    );
  });
});
