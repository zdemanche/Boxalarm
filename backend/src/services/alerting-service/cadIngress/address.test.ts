import { describe, expect, it } from 'vitest';
import { isAligned, parseFromHeader, parseFromHeaders } from './address.js';

describe('parseFromHeader (RFC 5322 mailbox; security review C1)', () => {
  it.each([
    ['dispatch@cad.county.gov', 'dispatch@cad.county.gov'],
    ['<dispatch@cad.county.gov>', 'dispatch@cad.county.gov'],
    ['County Dispatch <Dispatch@CAD.county.gov>', 'dispatch@cad.county.gov'],
    ['"Dispatch, County" <dispatch@cad.county.gov>', 'dispatch@cad.county.gov'],
    ['"<fake@x.gov>" <clerk@county.gov>', 'clerk@county.gov'],
    ['"a \\" <fake@x.gov>" <clerk@county.gov>', 'clerk@county.gov'],
    ['clerk@county.gov (<dispatch@county.gov>)', 'clerk@county.gov'],
    ['clerk@county.gov (nested (<dispatch@county.gov>) comment)', 'clerk@county.gov'],
    ['(<dispatch@county.gov>) Clerk <clerk@county.gov>', 'clerk@county.gov'],
    ['=?utf-8?Q?Dispatch?= <dispatch@county.gov>', 'dispatch@county.gov'],
  ])('%s -> %s', (value, address) => {
    expect(parseFromHeader(value)).toMatchObject({ ok: true, address });
  });

  it.each([
    ['dispatch@county.gov, clerk@county.gov', 'MultipleMailboxes'],
    ['"Dispatch" <dispatch@county.gov>, clerk@county.gov', 'MultipleMailboxes'],
    ['<dispatch@county.gov> <clerk@county.gov>', 'MultipleMailboxes'],
    ['Undisclosed recipients:;', 'Group'],
    ['Dispatch: dispatch@county.gov;', 'Group'],
    ['dispatch@county.gov <clerk@county.gov>', 'AddressInDisplayName'],
    ['<clerk@county.gov> trailing', 'TrailingText'],
    ['"unterminated <clerk@county.gov>', 'Unterminated'],
    ['clerk@county.gov (unterminated', 'Unterminated'],
    ['<clerk@county.gov', 'Unterminated'],
    ['"quoted local"@county.gov', 'QuotedLocalPart'],
    ['not an address', 'NotAnAddress'],
    ['clerk@localhost', 'NotAnAddress'],
    ['clerk@county.gov\r\nBcc: x@y.gov', 'BareLineBreak'],
  ])('refuses %s (%s)', (value, reason) => {
    expect(parseFromHeader(value)).toEqual({ ok: false, reason });
  });

  it('refuses no From and more than one From header', () => {
    expect(parseFromHeaders([])).toEqual({ ok: false, reason: 'NoFrom' });
    expect(parseFromHeaders(['a@b.gov', 'c@d.gov'])).toEqual({
      ok: false,
      reason: 'MultipleFromHeaders',
    });
  });
});

describe('isAligned (relaxed, no public-suffix list)', () => {
  it.each([
    ['county.gov', 'county.gov', true],
    ['county.gov', 'cad.county.gov', true],
    ['mail.cad.county.gov', 'cad.county.gov', true],
    ['gov', 'county.gov', false],
    ['attacker.example', 'county.gov', false],
    ['evilcounty.gov', 'county.gov', false],
  ])('d=%s From %s -> %s', (d, from, aligned) => {
    expect(isAligned(d, from)).toBe(aligned);
  });
});
