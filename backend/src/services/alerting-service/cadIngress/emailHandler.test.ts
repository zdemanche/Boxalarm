import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { S3Client } from '@aws-sdk/client-s3';
import type { SESEvent } from 'aws-lambda';
import { fakeDynamo, type FakeTable } from './__fixtures__/fakeTable.js';
import { parseEmail } from './mime.js';

/**
 * The required email tests of docs/decisions/2026-09-29-cad-ingress-auth.md: every
 * authentication failure drops the message (never pages, not even raw), is counted and
 * quarantined; an authenticated but unparseable message pages with the raw text.
 */

const NOW = 1_800_000_000;
const DOMAIN = 'ingress.boxalarm.test';
const RECIPIENT = `dispatch+nichols-fd.county.k3j9x2m4p7q8@${DOMAIN}`;

const COPY = {
  pk: 'DEPT#nichols-fd#CAD_INGRESS',
  sk: 'METADATA',
  sources: [
    {
      sourceId: 'county',
      label: 'County CAD',
      enabled: true,
      email: { allowedSenders: ['cad.county.gov'], recipientToken: 'k3j9x2m4p7q8' },
      parser: {
        version: 1,
        fields: { incidentNumber: { label: 'INC' }, address: { label: 'ADDR' } },
      },
    },
  ],
};

function rawEmail(
  options: {
    from?: string;
    dkimDomains?: string[];
    date?: number;
    messageId?: string;
    body?: string;
    headers?: string;
    subject?: string;
    /** The whole From header value (overrides `from`). */
    fromHeader?: string;
    /** DKIM h= (default from:to:subject:date:message-id). */
    signedHeaders?: string;
    /** The To header value (default: this department's ingress address). */
    to?: string;
  } = {},
): string {
  const date = new Date((options.date ?? NOW) * 1000).toUTCString();
  const dkim = (options.dkimDomains ?? ['cad.county.gov'])
    .map(
      (domain, i) =>
        `DKIM-Signature: v=1; a=rsa-sha256; d=${domain}; s=sel; t=${options.date ?? NOW}; h=${options.signedHeaders ?? 'from:to:subject:date:message-id'};\r\n\tb=SIG${i}${domain.replace(/\W/g, '')}abc/def+==`,
    )
    .join('\r\n');
  return [
    dkim,
    `From: ${options.fromHeader ?? `"County Dispatch" <${options.from ?? 'dispatch@cad.county.gov'}>`}`,
    `To: ${options.to ?? RECIPIENT}`,
    `Date: ${date}`,
    `Message-ID: <${options.messageId ?? 'm-1@cad.county.gov'}>`,
    ...(options.subject !== undefined ? [`Subject: ${options.subject}`] : []),
    options.headers ?? 'Content-Type: text/plain; charset=utf-8',
    '',
    options.body ?? 'INC: 2026-7\r\nADDR: 123 MAIN ST, NICHOLS\r\n',
  ].join('\r\n');
}

type Verdict = 'PASS' | 'FAIL' | 'GRAY' | 'PROCESSING_FAILED';

function sesEvent(
  verdicts: Partial<Record<'spf' | 'dkim' | 'spam' | 'virus' | 'dmarc', Verdict>> = {},
  recipients = [RECIPIENT],
): SESEvent {
  return {
    Records: [
      {
        eventSource: 'aws:ses',
        eventVersion: '1.0',
        ses: {
          mail: { messageId: 'ses-1', timestamp: '', source: '', destination: recipients },
          receipt: {
            recipients,
            spfVerdict: { status: verdicts.spf ?? 'PASS' },
            dkimVerdict: { status: verdicts.dkim ?? 'PASS' },
            spamVerdict: { status: verdicts.spam ?? 'PASS' },
            virusVerdict: { status: verdicts.virus ?? 'PASS' },
            dmarcVerdict: { status: verdicts.dmarc ?? 'PASS' },
          },
        },
      },
    ],
  } as unknown as SESEvent;
}

describe('CAD email handler', () => {
  const originalEnv = { ...process.env };
  let table: FakeTable;
  let s3Send: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW * 1000);
    process.env.ALERTING_TABLE_NAME = 'alerting';
    process.env.CAD_MAIL_BUCKET = 'mail-bucket';
    process.env.CAD_INGRESS_EMAIL_DOMAIN = DOMAIN;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    table = { items: new Map([[`${COPY.pk}|${COPY.sk}`, COPY]]) };
    const dynamo = fakeDynamo(table);
    vi.doMock('../eligibility/dynamoClient.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../eligibility/dynamoClient.js')>()),
      createDynamoClient: () => dynamo,
    }));
    s3Send = vi.fn();
    serve(rawEmail());
    (await import('./emailHandler.js')).setS3Client({ send: s3Send } as unknown as S3Client);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function serve(raw: string) {
    s3Send.mockResolvedValue({
      ContentLength: raw.length,
      Body: { transformToByteArray: () => Promise.resolve(Buffer.from(raw, 'latin1')) },
    });
  }

  async function run(event = sesEvent()): Promise<void> {
    const { handler } = await import('./emailHandler.js');
    await handler(event);
  }

  const alerts = () =>
    [...table.items.values()].filter((item) => item.entityType === 'DISPATCH_ALERT');

  function metric(name: string, reason?: string): boolean {
    return vi
      .mocked(console.log)
      .mock.calls.some(
        ([line]) =>
          String(line).includes(`"Name":"${name}"`) &&
          (reason === undefined || String(line).includes(`"Reason":"${reason}"`)),
      );
  }

  function expectDropped(reason: string) {
    expect(alerts()).toHaveLength(0);
    expect(metric('CadIngressAuthFailed', reason)).toBe(true);
    expect(metric('CadIngressQuarantined')).toBe(true);
    const logged = vi.mocked(console.log).mock.calls.map(([line]) => String(line));
    // The body of a dropped message is never logged; the quarantine location is.
    expect(logged.some((line) => line.includes('123 MAIN ST'))).toBe(false);
    expect(logged.some((line) => line.includes('s3://mail-bucket/inbound/ses-1'))).toBe(true);
  }

  it('pages an authenticated, allowlisted, fresh message from the configured department', async () => {
    await run();
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toMatchObject({
      deptId: 'nichols-fd',
      sourceSystem: 'CAD',
      ingressChannel: 'cad-email',
      cadSourceId: 'county',
      address: '123 MAIN ST, NICHOLS',
      locality: { town: 'NICHOLS', choice: 'OTHER' },
    });
    expect(s3Send.mock.calls[0]?.[0]).toMatchObject({
      input: { Bucket: 'mail-bucket', Key: 'inbound/ses-1' },
    });
  });

  it('a forged From with DKIM PASS for another domain does not page (sender publishes no DMARC)', async () => {
    serve(rawEmail({ dkimDomains: ['attacker.example'] }));
    await run(sesEvent({ dmarc: 'GRAY' }));
    expectDropped('DkimNotAligned');
  });

  it('an aligned signature alongside a foreign one does not page without DMARC PASS', async () => {
    serve(rawEmail({ dkimDomains: ['cad.county.gov', 'attacker.example'] }));
    await run(sesEvent({ dmarc: 'GRAY' }));
    expectDropped('DkimNotAligned');
  });

  it.each(['GRAY', 'PROCESSING_FAILED'] as const)(
    'DMARC %s with every d= aligned to the From domain pages',
    async (dmarc) => {
      await run(sesEvent({ dmarc }));
      expect(alerts()).toHaveLength(1);
    },
  );

  function allowOnly(senders: string[]) {
    const copy = table.items.get(`${COPY.pk}|${COPY.sk}`)!;
    const sources = copy.sources as Record<string, unknown>[];
    table.items.set(`${COPY.pk}|${COPY.sk}`, {
      ...copy,
      sources: [
        {
          ...sources[0],
          email: { allowedSenders: senders, recipientToken: 'k3j9x2m4p7q8' },
        },
      ],
    });
  }

  describe('recipient binding (security review M2)', () => {
    it('a genuine county email to department A, redirected unchanged to B, does not page B', async () => {
      // Signed To is A's address; SES delivered it to B's (the configured RECIPIENT).
      serve(rawEmail({ to: `dispatch+other-fd.county.zzzzzzzzzzzz@${DOMAIN}` }));
      await run();
      expectDropped('RecipientNotSigned');
    });

    it('a signature that does not cover To does not page', async () => {
      serve(rawEmail({ signedHeaders: 'from:subject:date' }));
      await run();
      expectDropped('RecipientNotSigned');
    });

    it('the ingress address in a signed Cc pages', async () => {
      serve(
        rawEmail({
          to: 'someone@cad.county.gov',
          headers: `Cc: "Nichols FD" <${RECIPIENT}>\r\nContent-Type: text/plain`,
          signedHeaders: 'from:to:cc:date',
        }),
      );
      await run();
      expect(alerts()).toHaveLength(1);
    });
  });

  describe('From spoofing (security review C1): an ADDRESS allowlist entry is that address only', () => {
    it.each([
      [
        'a display name hiding the address',
        '"<dispatch@cad.county.gov>" <clerk@cad.county.gov>',
        'SenderNotAllowed',
      ],
      [
        'a comment hiding the address',
        'clerk@cad.county.gov (<dispatch@cad.county.gov>)',
        'SenderNotAllowed',
      ],
      ['two mailboxes', 'dispatch@cad.county.gov, clerk@cad.county.gov', 'FromUnparseable'],
      ['two angle-addrs', '<dispatch@cad.county.gov> <clerk@cad.county.gov>', 'FromUnparseable'],
      ['a group', 'Dispatch: dispatch@cad.county.gov;', 'FromUnparseable'],
      ['another mailbox on the same domain', 'clerk@cad.county.gov', 'SenderNotAllowed'],
    ])('%s does not page, even with DMARC PASS', async (_name, fromHeader, reason) => {
      allowOnly(['dispatch@cad.county.gov']);
      serve(rawEmail({ fromHeader }));
      await run(sesEvent({ dmarc: 'PASS' }));
      expectDropped(reason);
    });

    it('two From headers do not page', async () => {
      allowOnly(['dispatch@cad.county.gov']);
      serve(rawEmail({ headers: 'From: clerk@cad.county.gov\r\nContent-Type: text/plain' }));
      await run(sesEvent({ dmarc: 'PASS' }));
      expectDropped('FromUnparseable');
    });

    it('the exact allowlisted address with a display name pages', async () => {
      allowOnly(['dispatch@cad.county.gov']);
      serve(rawEmail({ fromHeader: '"County Dispatch (CAD)" <Dispatch@CAD.County.gov>' }));
      await run(sesEvent({ dmarc: 'PASS' }));
      expect(alerts()).toHaveLength(1);
    });
  });

  it('a From outside the allowlist does not page', async () => {
    serve(rawEmail({ from: 'someone@elsewhere.org' }));
    await run();
    expectDropped('SenderNotAllowed');
  });

  it.each([
    ['SPF FAIL', { spf: 'FAIL' }, 'SpfFailed'],
    ['SPF GRAY', { spf: 'GRAY' }, 'SpfFailed'],
    ['DKIM FAIL', { dkim: 'FAIL' }, 'DkimFailed'],
    ['virus FAIL', { virus: 'FAIL' }, 'Virus'],
    ['spam FAIL', { spam: 'FAIL' }, 'Spam'],
    ['DMARC FAIL', { dmarc: 'FAIL' }, 'DmarcFailed'],
  ] as const)('%s does not page', async (_name, verdicts, reason) => {
    await run(sesEvent(verdicts));
    expectDropped(reason);
    // Verdicts are checked before the raw message is even read.
    expect(s3Send).not.toHaveBeenCalled();
  });

  it('DMARC GRAY (no published policy) is accepted', async () => {
    await run(sesEvent({ dmarc: 'GRAY' }));
    expect(alerts()).toHaveLength(1);
  });

  it('a message more than 10 minutes old does not page', async () => {
    serve(rawEmail({ date: NOW - 601 }));
    await run();
    expectDropped('Stale');
  });

  it.each([
    ['a wrong recipient token', `dispatch+nichols-fd.county.zzzzzzzzzzzz@${DOMAIN}`],
    ['another domain', 'dispatch+nichols-fd.county.k3j9x2m4p7q8@other.test'],
    ['an unknown source', `dispatch+nichols-fd.nope.k3j9x2m4p7q8@${DOMAIN}`],
  ])('%s does not page', async (_name, recipient) => {
    await run(sesEvent({}, [recipient]));
    expectDropped('UnknownRecipient');
  });

  it('the same Message-ID + DKIM signature replayed does not page twice', async () => {
    await run();
    await run();
    expect(alerts()).toHaveLength(1);
    expect(metric('CadIngressReplayRejected')).toBe(true);
    const marker = [...table.items.values()].find((i) => i.entityType === 'CAD_REPLAY_MARKER');
    expect(marker).toMatchObject({ ttl: NOW + 86_400 });
  });

  it('a CAD resend of the same incident with a new Message-ID is a duplicate, not a second page', async () => {
    await run();
    serve(rawEmail({ messageId: 'm-2@cad.county.gov' }));
    await run();
    expect(alerts()).toHaveLength(1);
    expect(metric('CadIngressDuplicate')).toBe(true);
  });

  it('an authenticated but unparseable message pages with the raw text, flagged VERIFY', async () => {
    serve(rawEmail({ body: 'Fire reported behind the church on Main\r\n' }));
    await run();
    expect(alerts()[0]).toMatchObject({
      address: 'SEE DISPATCH TEXT',
      narrative: 'Fire reported behind the church on Main',
      cadParseStatus: 'RAW',
      verifyRequired: true,
    });
  });

  it('a dispatch carried in the Subject with an empty body pages with the Subject text, and a different Subject pages again', async () => {
    serve(rawEmail({ body: '', subject: 'ADDR: 5 OAK AVE' }));
    await run();
    serve(
      rawEmail({
        body: '',
        messageId: 'm-9@cad.county.gov',
        subject: 'ADDR: 77 PINE RD',
      }),
    );
    await run();
    expect(
      alerts()
        .map((a) => a.address)
        .sort(),
    ).toEqual(['5 OAK AVE', '77 PINE RD']);
  });

  it('a body naming another department still pages only the source department', async () => {
    serve(rawEmail({ body: 'DEPT: other-fd\r\nADDR: 9 OAK AVE\r\n' }));
    await run();
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]?.deptId).toBe('nichols-fd');
  });

  it('throws (async retry) when the mail bucket cannot be read; nothing is paged or claimed', async () => {
    s3Send.mockRejectedValue(new Error('s3 down'));
    await expect(run()).rejects.toThrow('s3 down');
    expect(table.items.size).toBe(1);
  });

  it('a failed dispatch write throws and leaves no marker; the async retry pages exactly once', async () => {
    table.failTransact = true;
    await expect(run()).rejects.toThrow();
    expect([...table.items.values()].some((i) => i.entityType === 'CAD_REPLAY_MARKER')).toBe(false);
    table.failTransact = false;
    await run(); // Lambda's retry of the identical event
    await run(); // and a genuine second delivery of it
    expect(alerts()).toHaveLength(1);
    expect(metric('CadIngressReplayRejected')).toBe(true);
  });
});

describe('CAD email Subject (chain review C1)', () => {
  it('reads an RFC 2047 encoded Subject', () => {
    const email = parseEmail(
      rawEmail({ subject: '=?utf-8?Q?STRUCTURE_FIRE_=E2=80=93_1_MAIN_ST?=' }),
    );
    expect(email.subject).toBe('STRUCTURE FIRE – 1 MAIN ST');
  });
});

describe('parseEmail', () => {
  it('reads a quoted-printable text part out of multipart/alternative', () => {
    const raw = [
      'From: CAD <dispatch@cad.county.gov>',
      'Date: Wed, 30 Sep 2026 07:00:00 GMT',
      'Content-Type: multipart/alternative; boundary="b1"',
      '',
      '--b1',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>ADDR: html</p>',
      '--b1',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: quoted-printable',
      '',
      'ADDR: 12 ELM ST=2C NICHOLS=',
      '',
      'TYPE: ALARM',
      '--b1--',
    ].join('\r\n');
    const email = parseEmail(raw);
    expect(email.text).toBe('ADDR: 12 ELM ST, NICHOLS\r\nTYPE: ALARM');
    expect(email.fromDomain).toBe('cad.county.gov');
    expect(email.date).toBe(Date.parse('Wed, 30 Sep 2026 07:00:00 GMT') / 1000);
  });

  it('reads folded DKIM-Signature headers', () => {
    const email = parseEmail(rawEmail());
    expect(email.dkimSignatures).toEqual([
      {
        domain: 'cad.county.gov',
        signature: 'SIG0cadcountygovabc/def+==',
        timestamp: NOW,
        signedHeaders: ['from', 'to', 'subject', 'date', 'message-id'],
      },
    ]);
  });
});
