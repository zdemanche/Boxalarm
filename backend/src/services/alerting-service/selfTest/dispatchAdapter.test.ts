import { describe, expect, it } from 'vitest';
import { buildSelfTestDispatch, selfTestAdapter } from './dispatchAdapter.js';

describe('buildSelfTestDispatch', () => {
  it('mints a SELF_TEST dispatch whose externalDispatchId is the given testId', () => {
    const dispatch = buildSelfTestDispatch('1798000000');
    expect(dispatch.sourceSystem).toBe('SELF_TEST');
    expect(dispatch.externalDispatchId).toBe('1798000000');
    expect(dispatch.unitsRequested).toEqual([]);
  });
});

describe('selfTestAdapter.normalize', () => {
  it('normalizes a { testId } payload into a SELF_TEST DispatchReceived', () => {
    const result = selfTestAdapter.normalize({ testId: '1798000001' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sourceSystem).toBe('SELF_TEST');
      expect(result.value.externalDispatchId).toBe('1798000001');
    }
  });

  it('rejects a payload missing testId', () => {
    const result = selfTestAdapter.normalize({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.field).toBe('testId');
    }
  });

  it('rejects a non-object payload', () => {
    const result = selfTestAdapter.normalize(null);
    expect(result.ok).toBe(false);
  });
});
