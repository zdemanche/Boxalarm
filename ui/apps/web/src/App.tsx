import { palette, spacing } from '@boxalarm/design-tokens';
import { BrowserRouter, Route, Routes } from 'react-router-dom';

function Placeholder() {
  return (
    <main style={{ color: palette.day.foreground, padding: spacing.lg }}>
      <h1>Boxalarm</h1>
    </main>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Placeholder />} />
      </Routes>
    </BrowserRouter>
  );
}
