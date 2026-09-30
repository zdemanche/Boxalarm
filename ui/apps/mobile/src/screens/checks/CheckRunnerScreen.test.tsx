import { targetSize } from '@boxalarm/design-tokens';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { AccessibilityInfo } from 'react-native';
import { launchCamera } from 'react-native-image-picker';
import { kvDelete } from '../../sync/kvStore';
import { CheckRunnerScreen } from './CheckRunnerScreen';
import { mockChecksRepository } from '../../features/checks/mockChecksRepository';

const mockLaunchCamera = launchCamera as jest.Mock;

const mockRoute = { params: { apparatusId: 'APP-ENGINE-2' } };
const mockNavigate = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useRoute: () => mockRoute,
  useNavigation: () => ({ goBack: jest.fn(), navigate: mockNavigate }),
}));

/** Answer the first item by hand, then bulk-pass the rest (bulk OK needs one real answer). */
async function passEveryItem() {
  const pass = (await screen.findAllByRole('radio')).find(
    (r) => r.props.accessibilityLabel === 'Pass',
  )!;
  await act(async () => {
    fireEvent.press(pass);
  });
  await act(async () => {
    fireEvent.press(await screen.findByText(/^Mark the other \d+ OK$/));
  });
}

beforeEach(async () => {
  mockNavigate.mockClear();
  // The on-device journal persists across renders by design; start each test with no check in
  // progress.
  await kvDelete('check-draft:anon:APP-ENGINE-2');
});

test('lists every item from the apparatus\u2019s checklist template', async () => {
  const { findByText } = await render(<CheckRunnerScreen />);

  expect(await findByText('Tires and wheels')).toBeTruthy();
  expect(await findByText('SCBA units present and charged')).toBeTruthy();
});

test('Submit is always visible and counts what is still unanswered', async () => {
  const { findByText, findAllByRole } = await render(<CheckRunnerScreen />);

  expect(await findByText('Submit check — 5 unanswered')).toBeTruthy();
  const passes = (await findAllByRole('radio')).filter(
    (r) => r.props.accessibilityLabel === 'Pass',
  );
  await act(async () => {
    fireEvent.press(passes[0]!);
  });
  expect(await findByText('Submit check — 4 unanswered')).toBeTruthy();
  expect(await findByText('1 of 5 checked')).toBeTruthy();
});

test('submitting with items unanswered names them instead of submitting', async () => {
  const submitSpy = jest.spyOn(mockChecksRepository, 'submitChecklistRun');
  const { findByText, findByRole } = await render(<CheckRunnerScreen />);

  await act(async () => {
    fireEvent.press(await findByText('Submit check — 5 unanswered'));
  });

  expect((await findByRole('alert')).props.children).toMatch(
    /Answer 5 more items.*Tires and wheels/,
  );
  expect(submitSpy).not.toHaveBeenCalled();
  submitSpy.mockRestore();
});

test('"Mark the other N OK" appears only after an item is answered, then passes the rest', async () => {
  const { findByText, queryByText, findAllByRole } = await render(<CheckRunnerScreen />);

  await findByText('Tires and wheels');
  expect(queryByText(/Mark the other/)).toBeNull();
  const pass = (await findAllByRole('radio')).find((r) => r.props.accessibilityLabel === 'Pass')!;
  await act(async () => {
    fireEvent.press(pass);
  });
  await act(async () => {
    fireEvent.press(await findByText('Mark the other 4 OK'));
  });

  expect(await findByText('5 of 5 checked')).toBeTruthy();
  expect(await findByText('Submit check')).toBeTruthy();
});

test('critical items are never included in bulk OK', async () => {
  const spy = jest.spyOn(mockChecksRepository, 'getChecklistTemplate').mockResolvedValueOnce({
    templateId: 'CT-CRIT',
    name: 'Critical sheet',
    items: [
      { code: 'A', label: 'Lights', requiresPhoto: false },
      { code: 'B', label: 'Brakes', requiresPhoto: false, critical: true },
      { code: 'C', label: 'Mirrors', requiresPhoto: false },
    ],
  });
  const { findByText, findAllByRole } = await render(<CheckRunnerScreen />);

  await findByText('Lights');
  const pass = (await findAllByRole('radio')).find((r) => r.props.accessibilityLabel === 'Pass')!;
  await act(async () => {
    fireEvent.press(pass);
  });
  await act(async () => {
    fireEvent.press(await findByText('Mark the other 1 OK'));
  });

  expect(await findByText('Submit check — 1 unanswered')).toBeTruthy();
  spy.mockRestore();
});

test('Pass and Fail are radios that expose which one is selected', async () => {
  const { findAllByRole } = await render(<CheckRunnerScreen />);

  const radios = await findAllByRole('radio');
  const firstFail = radios.find((r) => r.props.accessibilityLabel === 'Fail')!;
  await act(async () => {
    fireEvent.press(firstFail);
  });

  const after = await findAllByRole('radio');
  const fail = after.find((r) => r.props.accessibilityLabel === 'Fail')!;
  const pass = after.find((r) => r.props.accessibilityLabel === 'Pass')!;
  expect(fail.props.accessibilityState.checked).toBe(true);
  expect(pass.props.accessibilityState.checked).toBe(false);
  expect(fail.props.style.minHeight).toBeGreaterThanOrEqual(targetSize.field);
});

test('a failed item becomes a pre-filled defect report on submit, so it reaches the officer', async () => {
  const defectSpy = jest.spyOn(mockChecksRepository, 'submitDefect');
  const runSpy = jest.spyOn(mockChecksRepository, 'submitChecklistRun');
  const { findByText, findAllByRole, findByLabelText } = await render(<CheckRunnerScreen />);

  const fail = (await findAllByRole('radio')).find((r) => r.props.accessibilityLabel === 'Fail')!;
  await act(async () => {
    fireEvent.press(fail);
  });
  await act(async () => {
    fireEvent.press(await findByText('Out of service now'));
  });
  expect(await findByText(/takes APP-ENGINE-2 out of service/)).toBeTruthy();
  await act(async () => {
    fireEvent.changeText(
      await findByLabelText("What's wrong with Tires and wheels (optional)"),
      'Sidewall cut, left front',
    );
  });
  await act(async () => {
    fireEvent.press(await findByText('Mark the other 4 OK'));
  });
  await act(async () => {
    fireEvent.press(await findByText('Submit check'));
  });

  expect(defectSpy).toHaveBeenCalledTimes(1);
  expect(defectSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      apparatusId: 'APP-ENGINE-2',
      severity: 'OUT_OF_SERVICE',
      description:
        'Failed on the APP-ENGINE-2 truck check: Tires and wheels. Sidewall cut, left front',
    }),
  );
  const runKey = runSpy.mock.calls[0]?.[0].idempotencyKey;
  expect(defectSpy.mock.calls[0]?.[0].idempotencyKey).toBe(`${runKey}-defect-TIRES`);
  expect(runSpy.mock.calls[0]?.[0].itemResults).toContainEqual({
    code: 'TIRES',
    pass: false,
    note: 'Sidewall cut, left front',
  });
  expect(await findByText('Reported to the apparatus officer:')).toBeTruthy();
  expect(await findByText('✕ Tires and wheels — Out of service now')).toBeTruthy();
  defectSpy.mockRestore();
  runSpy.mockRestore();
});

test('answers are saved as you go and restored after the screen is torn down', async () => {
  const first = await render(<CheckRunnerScreen />);
  const passes = (await first.findAllByRole('radio')).filter(
    (r) => r.props.accessibilityLabel === 'Pass',
  );
  await act(async () => {
    fireEvent.press(passes[0]!);
  });
  await act(async () => {
    fireEvent.press(passes[1]!);
  });
  expect(await first.findByText('2 of 5 checked')).toBeTruthy();
  // Let the journal write land, then simulate the OS killing the screen: a fresh mount has
  // none of the first one's React state, only what the phone saved.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    first.unmount();
  });

  const second = await render(<CheckRunnerScreen />);
  expect(await second.findByText('2 of 5 checked')).toBeTruthy();
  expect(await second.findByText(/Restored your check in progress/)).toBeTruthy();
});

test('shows a loading state instead of a blank screen while the sheet loads', async () => {
  const spy = jest
    .spyOn(mockChecksRepository, 'getChecklistTemplate')
    .mockReturnValueOnce(new Promise(() => undefined));
  const { findByText } = await render(<CheckRunnerScreen />);

  expect(await findByText('Loading the APP-ENGINE-2 check sheet…')).toBeTruthy();
  spy.mockRestore();
});

test('completing the check submits optimistically and confirms immediately, no spinner wait', async () => {
  const submitSpy = jest.spyOn(mockChecksRepository, 'submitChecklistRun');
  const { findByText } = await render(<CheckRunnerScreen />);

  await findByText('Tires and wheels');
  await passEveryItem();
  await act(async () => {
    fireEvent.press(await findByText('Submit check'));
  });

  expect(await findByText(/check complete/i)).toBeTruthy();
  expect(submitSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      apparatusId: 'APP-ENGINE-2',
      itemResults: expect.arrayContaining([expect.objectContaining({ code: 'TIRES', pass: true })]),
    }),
  );
  submitSpy.mockRestore();
});

test('linking to defect report carries the apparatus id along', async () => {
  const { findByText } = await render(<CheckRunnerScreen />);

  await findByText('Tires and wheels');
  fireEvent.press(await findByText('Report a defect'));
  expect(mockNavigate).toHaveBeenCalledWith('DefectReport', { apparatusId: 'APP-ENGINE-2' });
});

test('announces check completion for screen reader users, since the screen swaps entirely', async () => {
  const announceSpy = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
  const { findByText } = await render(<CheckRunnerScreen />);

  await findByText('Tires and wheels');
  await passEveryItem();
  await act(async () => {
    fireEvent.press(await findByText('Submit check'));
  });

  expect(announceSpy).toHaveBeenCalledWith(expect.stringMatching(/check complete/i));
  announceSpy.mockRestore();
});

test('report a defect meets the glove-sized field target, not just its text height', async () => {
  const { findByRole } = await render(<CheckRunnerScreen />);

  const link = await findByRole('button', { name: 'Report a defect' });
  expect(link.props.style.minHeight).toBe(targetSize.field);
});

test('an item requiring a photo cannot be marked pass or fail until a photo is captured', async () => {
  const templateSpy = jest
    .spyOn(mockChecksRepository, 'getChecklistTemplate')
    .mockResolvedValueOnce({
      templateId: 'CT-PHOTO',
      name: 'Photo-required check',
      items: [{ code: 'SCBA', label: 'SCBA units present and charged', requiresPhoto: true }],
    });

  mockLaunchCamera.mockResolvedValueOnce({
    didCancel: false,
    assets: [{ uri: 'file:///tmp/scba.jpg', fileName: 'scba.jpg', type: 'image/jpeg' }],
  });
  const { findByText, findByRole } = await render(<CheckRunnerScreen />);
  await findByText('SCBA units present and charged');

  expect((await findByRole('radio', { name: 'Pass' })).props.accessibilityState.disabled).toBe(
    true,
  );

  await act(async () => {
    fireEvent.press(await findByRole('button', { name: 'Add photo' }));
  });

  expect(await findByRole('button', { name: 'Photo captured' })).toBeTruthy();
  expect((await findByRole('radio', { name: 'Pass' })).props.accessibilityState.disabled).toBe(
    false,
  );

  templateSpy.mockRestore();
});

test('a camera error surfaces to the crew instead of silently leaving the item ungated', async () => {
  const templateSpy = jest
    .spyOn(mockChecksRepository, 'getChecklistTemplate')
    .mockResolvedValueOnce({
      templateId: 'CT-PHOTO',
      name: 'Photo-required check',
      items: [{ code: 'SCBA', label: 'SCBA units present and charged', requiresPhoto: true }],
    });
  mockLaunchCamera.mockResolvedValueOnce({ didCancel: false, errorCode: 'camera_unavailable' });

  const { findByText, findByRole } = await render(<CheckRunnerScreen />);
  await findByText('SCBA units present and charged');

  await act(async () => {
    fireEvent.press(await findByRole('button', { name: 'Add photo' }));
  });

  expect(await findByText('camera_unavailable')).toBeTruthy();
  expect((await findByRole('radio', { name: 'Pass' })).props.accessibilityState.disabled).toBe(
    true,
  );

  templateSpy.mockRestore();
});

test('a checklist API error shows a message and retry instead of a blank screen (M10)', async () => {
  const { ApiError } = jest.requireActual('../../lib/apiClient');
  const templateSpy = jest
    .spyOn(mockChecksRepository, 'getChecklistTemplate')
    .mockRejectedValueOnce(
      new ApiError({ type: 'about:blank', title: 'Server Error', status: 500, traceId: 't' }),
    );

  const { findByRole, findByText } = await render(<CheckRunnerScreen />);

  expect((await findByRole('alert')).props.children).toBe('The checklist could not be loaded.');
  await act(async () => {
    fireEvent.press(await findByRole('button', { name: 'Try again' }));
  });
  expect(await findByText('Tires and wheels')).toBeTruthy();

  templateSpy.mockRestore();
});

test('a failed local save does not confirm the check, and a retry reuses the idempotency key (C1)', async () => {
  const submitSpy = jest
    .spyOn(mockChecksRepository, 'submitChecklistRun')
    .mockRejectedValueOnce(new Error('storage full'));
  const { findByText, findByRole, queryByText } = await render(<CheckRunnerScreen />);

  await findByText('Tires and wheels');
  await passEveryItem();
  await act(async () => {
    fireEvent.press(await findByText('Submit check'));
  });

  expect((await findByRole('alert')).props.children).toBe(
    'The check could not be saved on this device. Your answers are still here. Try again.',
  );
  expect(queryByText(/^check complete/i)).toBeNull();

  await act(async () => {
    fireEvent.press(await findByText('Submit check'));
  });
  expect(await findByRole('header')).toBeTruthy();
  const [first, second] = submitSpy.mock.calls;
  expect(second?.[0].idempotencyKey).toBe(first?.[0].idempotencyKey);
  submitSpy.mockRestore();
});

test('a photo on a failed item goes with its defect; one on a passing item is reported as not sent', async () => {
  const templateSpy = jest
    .spyOn(mockChecksRepository, 'getChecklistTemplate')
    .mockResolvedValueOnce({
      templateId: 'CT-PHOTO2',
      name: 'Photo check',
      items: [
        { code: 'SCBA', label: 'SCBA units present and charged', requiresPhoto: true },
        { code: 'HOSE', label: 'Hose bed', requiresPhoto: false },
      ],
    });
  const defectSpy = jest.spyOn(mockChecksRepository, 'submitDefect');
  mockLaunchCamera
    .mockResolvedValueOnce({
      didCancel: false,
      assets: [{ uri: 'file:///tmp/scba.jpg', fileName: 'scba.jpg', type: 'image/jpeg' }],
    })
    .mockResolvedValueOnce({
      didCancel: false,
      assets: [{ uri: 'file:///tmp/hose.jpg', fileName: 'hose.jpg', type: 'image/jpeg' }],
    });
  const { findByText, findByRole, findAllByRole } = await render(<CheckRunnerScreen />);

  await act(async () => {
    fireEvent.press(await findByRole('button', { name: 'Add photo' }));
  });
  const radios = await findAllByRole('radio');
  await act(async () => {
    fireEvent.press(radios.filter((r) => r.props.accessibilityLabel === 'Pass')[0]!);
  });
  await act(async () => {
    fireEvent.press(
      (await findAllByRole('radio')).filter((r) => r.props.accessibilityLabel === 'Fail')[1]!,
    );
  });
  await act(async () => {
    fireEvent.press(await findByText('Add photo of the defect (optional)'));
  });
  await act(async () => {
    fireEvent.press(await findByText('Submit check'));
  });

  expect(defectSpy).toHaveBeenCalledWith(
    expect.objectContaining({ photoLocalUri: 'file:///tmp/hose.jpg', photoFileName: 'hose.jpg' }),
  );
  expect(await findByText(/1 photo taken on items that passed was not sent/)).toBeTruthy();
  templateSpy.mockRestore();
  defectSpy.mockRestore();
});
