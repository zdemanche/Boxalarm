import { fireEvent, render } from '@testing-library/react-native';
import { AccessibilityInfo, Platform, StyleSheet } from 'react-native';
import { ApiError } from '../../lib/apiClient';
import { mockAlertsRepository } from '../../features/alerts/mockAlertsRepository';
import { ManualDispatchEntryScreen } from './ManualDispatchEntryScreen';

const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
}));

beforeEach(() => {
  mockNavigate.mockClear();
});

// RNTL 14's fireEvent is async and act-wrapped: every call must be awaited, or overlapping act
// scopes leak into the tests that follow and their state updates never flush.

test('submitting a valid manual entry navigates to the new dispatch roster', async () => {
  const { getByLabelText, findByRole } = await render(<ManualDispatchEntryScreen />);

  await fireEvent.changeText(getByLabelText('Incident type (required)'), 'Structure fire');
  await fireEvent.changeText(getByLabelText('Address (required)'), '12 Elm St');
  await fireEvent.changeText(getByLabelText('Cross streets (required)'), 'Main & Elm');
  await fireEvent.press(await findByRole('radio', { name: 'Nichols' }));
  await fireEvent.changeText(getByLabelText('Narrative (required)'), 'Smoke showing');
  await fireEvent.changeText(getByLabelText('Operator-entered reference (required)'), 'ext-1');
  await fireEvent.press(await findByRole('button', { name: 'Submit dispatch' }));

  expect(mockNavigate).toHaveBeenCalledWith('Roster', {
    dispatchId: expect.any(String) as unknown as string,
  });
});

test('a 409 says no new page was sent and that a new call needs a different reference', async () => {
  const submit = jest
    .spyOn(mockAlertsRepository, 'submitManualDispatch')
    .mockRejectedValueOnce(
      new ApiError({ type: 'about:blank', title: 'Conflict', status: 409, traceId: 't' }),
    );
  const { getByLabelText, findByRole, findByText } = await render(<ManualDispatchEntryScreen />);

  await fireEvent.changeText(getByLabelText('Incident type (required)'), 'Structure fire');
  await fireEvent.changeText(getByLabelText('Address (required)'), '12 Elm St');
  await fireEvent.changeText(getByLabelText('Cross streets (required)'), 'Main & Elm');
  await fireEvent.changeText(getByLabelText('Narrative (required)'), 'Smoke showing');
  await fireEvent.press(await findByRole('radio', { name: 'Nichols' }));
  await fireEvent.changeText(getByLabelText('Operator-entered reference (required)'), 'ext-1');
  await fireEvent.press(await findByRole('button', { name: 'Submit dispatch' }));

  expect(
    await findByText(
      'No new page was sent: the same reference was entered in the last 10 minutes. A new call needs a different reference.',
    ),
  ).toBeTruthy();
  expect(mockNavigate).not.toHaveBeenCalled();
  submit.mockRestore();
});

test('B2-230: blank cross streets, narrative or reference is refused on the phone, in plain words, before anything is sent', async () => {
  const submit = jest.spyOn(mockAlertsRepository, 'submitManualDispatch');
  const { getByLabelText, findByRole, findByText } = await render(<ManualDispatchEntryScreen />);

  await fireEvent.changeText(getByLabelText('Incident type (required)'), 'Structure fire');
  await fireEvent.changeText(getByLabelText('Address (required)'), '12 Elm St');
  await fireEvent.press(await findByRole('radio', { name: 'Nichols' }));
  await fireEvent.press(await findByRole('button', { name: 'Submit dispatch' }));

  expect(await findByText('Enter the cross streets.')).toBeTruthy();
  expect(await findByText('Enter the narrative.')).toBeTruthy();
  expect(await findByText('Enter a reference for this call.')).toBeTruthy();
  expect(submit).not.toHaveBeenCalled();
  expect(mockNavigate).not.toHaveBeenCalled();
  submit.mockRestore();
});

test('a 400 from the server maps its field errors onto the fields', async () => {
  const submit = jest.spyOn(mockAlertsRepository, 'submitManualDispatch').mockRejectedValueOnce(
    new ApiError({
      type: 'about:blank',
      title: 'Bad Request',
      status: 400,
      traceId: 't',
      errors: [{ field: 'externalDispatchId', message: "cannot contain '#'" }],
    } as never),
  );
  const { getByLabelText, findByRole, findByText } = await render(<ManualDispatchEntryScreen />);

  await fireEvent.changeText(getByLabelText('Incident type (required)'), 'Structure fire');
  await fireEvent.changeText(getByLabelText('Address (required)'), '12 Elm St');
  await fireEvent.changeText(getByLabelText('Cross streets (required)'), 'Main & Elm');
  await fireEvent.changeText(getByLabelText('Narrative (required)'), 'Smoke showing');
  await fireEvent.changeText(getByLabelText('Operator-entered reference (required)'), 'a#b');
  await fireEvent.press(await findByRole('radio', { name: 'Nichols' }));
  await fireEvent.press(await findByRole('button', { name: 'Submit dispatch' }));

  expect(await findByText("cannot contain '#'")).toBeTruthy();
  submit.mockRestore();
});

test('leaves the form usable without crashing when required fields are empty', async () => {
  const { findByRole } = await render(<ManualDispatchEntryScreen />);

  await fireEvent.press(await findByRole('button', { name: 'Submit dispatch' }));

  expect(await findByRole('button', { name: 'Submit dispatch' })).toBeTruthy();
});

test('R3-A: the locality choice is required, and "Other town" sends the typed town', async () => {
  const submit = jest.spyOn(mockAlertsRepository, 'submitManualDispatch');
  const { getByLabelText, findByLabelText, findByRole, findByText } = await render(
    <ManualDispatchEntryScreen />,
  );

  await fireEvent.changeText(await findByLabelText('Incident type (required)'), 'Structure fire');
  await fireEvent.changeText(getByLabelText('Address (required)'), '123 Main St');
  await fireEvent.changeText(getByLabelText('Cross streets (required)'), 'Main & Elm');
  await fireEvent.changeText(getByLabelText('Narrative (required)'), 'Mutual aid');
  await fireEvent.changeText(getByLabelText('Operator-entered reference (required)'), 'ext-2');

  await fireEvent.press(await findByRole('button', { name: 'Submit dispatch' }));
  expect(await findByText('Choose the town or village.')).toBeTruthy();
  expect(submit).not.toHaveBeenCalled();

  await fireEvent.press(await findByRole('radio', { name: 'Other town…' }));
  expect((await findByLabelText('Other town name')).props.maxLength).toBe(80);
  await fireEvent.changeText(await findByLabelText('Other town name'), 'Bridgeport');
  await fireEvent.press(await findByRole('button', { name: 'Submit dispatch' }));

  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({
      address: '123 Main St',
      locality: { town: 'Bridgeport', choice: 'OTHER' },
    }),
  );
  submit.mockRestore();
});

test('M1: a successful submit resets the form, so the next call starts with no town chosen', async () => {
  const { getByLabelText, findByRole, findAllByRole } = await render(<ManualDispatchEntryScreen />);

  await fireEvent.changeText(getByLabelText('Incident type (required)'), 'Structure fire');
  await fireEvent.changeText(getByLabelText('Address (required)'), '12 Elm St');
  await fireEvent.changeText(getByLabelText('Cross streets (required)'), 'Main & Elm');
  await fireEvent.changeText(getByLabelText('Narrative (required)'), 'Smoke showing');
  await fireEvent.changeText(getByLabelText(/^Units requested/), 'E1, L1');
  await fireEvent.press(await findByRole('radio', { name: 'Trumbull' }));
  await fireEvent.changeText(getByLabelText('Operator-entered reference (required)'), 'ext-3');
  await fireEvent.press(await findByRole('button', { name: 'Submit dispatch' }));
  expect(mockNavigate).toHaveBeenCalledTimes(1);

  // The screen stays mounted under Roster: coming back must not carry "Trumbull" forward.
  const radios = await findAllByRole('radio');
  expect(radios.length).toBeGreaterThan(1);
  for (const radio of radios) {
    expect(radio.props.accessibilityState).toEqual({ checked: false });
  }
  expect(getByLabelText('Incident type (required)').props.value).toBe('');
  expect(getByLabelText('Address (required)').props.value).toBe('');
  expect(getByLabelText(/^Units requested/).props.value).toBe('');
  expect(getByLabelText('Operator-entered reference (required)').props.value).toBe('');
});

describe('m8: locality choice accessibility', () => {
  test('the radio group has an accessible name, and "Other town…" comes first', async () => {
    const { findByRole, findAllByRole, getByTestId } = await render(<ManualDispatchEntryScreen />);

    // The group View is deliberately not `accessible` (that would hide its radios on iOS), so
    // RNTL's role query cannot see it; assert the name it exposes instead.
    const group = getByTestId('locality-group');
    expect(group.props.accessibilityRole).toBe('radiogroup');
    expect(group.props.accessibilityLabel).toBe('Town / village (required)');
    expect(group.props.accessibilityLabelledBy).toBe('locality-label');
    await findByRole('radio', { name: 'Trumbull' });
    const names = (await findAllByRole('radio')).map((radio) => radio.props.accessibilityLabel);
    expect(names[0]).toBe('Other town…');
    expect(names).toContain('Trumbull');
  });

  test('the missing-town error is a live region and is announced on iOS', async () => {
    const announce = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => undefined);
    // react-native's jest setup already mocks it: drop calls made by earlier tests.
    announce.mockClear();
    const { getByLabelText, findByRole, findByText } = await render(<ManualDispatchEntryScreen />);
    await fireEvent.changeText(getByLabelText('Incident type (required)'), 'Structure fire');
    await fireEvent.changeText(getByLabelText('Address (required)'), '12 Elm St');
    await fireEvent.changeText(getByLabelText('Cross streets (required)'), 'Main & Elm');
    await fireEvent.changeText(getByLabelText('Narrative (required)'), 'Smoke showing');
    await fireEvent.changeText(getByLabelText('Operator-entered reference (required)'), 'ext-4');

    await fireEvent.press(await findByRole('button', { name: 'Submit dispatch' }));

    const error = await findByText('Choose the town or village.');
    expect(error.props.accessibilityLiveRegion).toBe('polite');
    expect(Platform.OS).toBe('ios');
    expect(announce).toHaveBeenCalledWith('Choose the town or village.');

    // S2: a repeated failed submit announces the same error again.
    await fireEvent.press(await findByRole('button', { name: 'Submit dispatch' }));
    expect(announce).toHaveBeenCalledTimes(2);
    announce.mockRestore();
  });

  test('locality targets are at least 48dp on Android', async () => {
    const original = Platform.OS;
    Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
    try {
      const { findByRole, findByLabelText } = await render(<ManualDispatchEntryScreen />);
      const other = await findByRole('radio', { name: 'Other town…' });
      expect(StyleSheet.flatten(other.props.style).minHeight).toBeGreaterThanOrEqual(48);
      await fireEvent.press(other);
      const input = await findByLabelText('Other town name');
      expect(StyleSheet.flatten(input.props.style).minHeight).toBeGreaterThanOrEqual(48);
    } finally {
      Object.defineProperty(Platform, 'OS', { value: original, configurable: true });
    }
  });
});
