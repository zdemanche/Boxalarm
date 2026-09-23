import { palette } from '@boxalarm/design-tokens';
import { certificationStatusColor, certificationStatusLabel } from './certificationStatus';

describe('certificationStatusColor', () => {
  test('CURRENT uses the success color', () => {
    expect(certificationStatusColor('CURRENT', palette.day)).toBe(palette.day.success);
  });

  test('EXPIRED uses the error color', () => {
    expect(certificationStatusColor('EXPIRED', palette.day)).toBe(palette.day.error);
  });

  test('REVOKED uses the error color', () => {
    expect(certificationStatusColor('REVOKED', palette.day)).toBe(palette.day.error);
  });
});

describe('certificationStatusLabel', () => {
  test('renders each status as title case', () => {
    expect(certificationStatusLabel('CURRENT')).toBe('Current');
    expect(certificationStatusLabel('EXPIRED')).toBe('Expired');
    expect(certificationStatusLabel('REVOKED')).toBe('Revoked');
  });
});
