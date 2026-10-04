import { describe, expect, it } from 'vitest';
import { toVerifiedDeptId } from '@boxalarm/dept-scope';
import { withCurrentText } from './handler.js';

/** Chain review R2-M2: tone 1 is built from the dispatch as it is now, not the INSERT image. */
describe('withCurrentText', () => {
  const inserted = {
    dispatchId: 'd-1',
    deptId: toVerifiedDeptId({ deptId: 'nichols-fd' }),
    incidentType: 'ALARM',
    address: '12 ELM ST',
    crossStreets: 'OAK',
    narrative: 'n',
    mapLink: undefined,
    isTest: false,
    sourceSystem: 'CAD',
    targetMemberId: undefined,
    selfTestId: undefined,
    channelsTested: undefined,
    dispatchedAt: 1,
    testDelivery: undefined,
    verifyRequired: true,
  };

  it('takes the current record where it has the field', () => {
    expect(
      withCurrentText(inserted, { address: '21 ELM ST', verifyRequired: false, fanOutAttempts: 1 }),
    ).toMatchObject({ address: '21 ELM ST', verifyRequired: false, incidentType: 'ALARM' });
  });

  it('keeps the stream image when the read returned nothing (never blanks a page)', () => {
    expect(withCurrentText(inserted, undefined)).toBe(inserted);
    expect(withCurrentText(inserted, { fanOutAttempts: 1 })).toMatchObject({
      address: '12 ELM ST',
      verifyRequired: true,
    });
  });
});
