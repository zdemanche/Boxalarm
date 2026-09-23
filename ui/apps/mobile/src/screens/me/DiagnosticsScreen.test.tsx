import { render } from '@testing-library/react-native';
import { DiagnosticsScreen } from './DiagnosticsScreen';

test('explains the diagnostic tool and its current not-yet-available state', async () => {
  const { findByText } = await render(<DiagnosticsScreen />);

  expect(await findByText("Why didn't I get the page?")).toBeTruthy();
  expect(await findByText(/not yet connected/i)).toBeTruthy();
});
