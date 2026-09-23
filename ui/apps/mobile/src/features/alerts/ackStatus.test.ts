import { palette } from '@boxalarm/design-tokens';
import { ackStatusColor, ackStatusLabel } from './ackStatus';

test('RESPONDING is colored with the success token', () => {
  expect(ackStatusColor('RESPONDING', palette.day)).toBe(palette.day.success);
});

test('NOT_RESPONDING is colored with the error token', () => {
  expect(ackStatusColor('NOT_RESPONDING', palette.day)).toBe(palette.day.error);
});

test('UNANSWERED is colored with the foreground token', () => {
  expect(ackStatusColor('UNANSWERED', palette.day)).toBe(palette.day.foreground);
});

test('labels are human-readable', () => {
  expect(ackStatusLabel('RESPONDING')).toBe('Responding');
  expect(ackStatusLabel('NOT_RESPONDING')).toBe('Not responding');
  expect(ackStatusLabel('UNANSWERED')).toBe('Awaiting response');
});
