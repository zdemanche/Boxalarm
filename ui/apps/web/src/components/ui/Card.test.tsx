import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, test } from 'vitest';
import { Stat } from './Card';

afterEach(cleanup);

describe('Stat', () => {
  test('renders label and value as plain text when it has no destination', () => {
    render(<Stat label="Out of service" value={2} />);
    expect(screen.getByText('Out of service')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  // design.md O-02: "every KPI tile links to its source list".
  test('links the whole tile to its source list when given a destination', () => {
    render(
      <MemoryRouter>
        <Stat label="Out of service" value={2} to="/apparatus" />
      </MemoryRouter>,
    );
    const link = screen.getByRole('link', { name: /out of service\s*2/i });
    expect(link.getAttribute('href')).toBe('/apparatus');
  });
});
