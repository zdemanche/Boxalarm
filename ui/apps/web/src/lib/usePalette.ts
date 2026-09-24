import { useCallback, useEffect, useState } from 'react';

export type Palette = 'day' | 'cab';

const STORAGE_KEY = 'bx-palette';

function readStoredPalette(): Palette | null {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return stored === 'day' || stored === 'cab' ? stored : null;
  } catch {
    return null;
  }
}

/** Office defaults to `day`, field defaults to `cab` (design.draft.md §1) — both surfaces let
 * the user switch. Web has no field/office distinction of its own, so it starts from `day` and
 * persists whatever the user picks; unset falls back to `prefers-color-scheme` (tokens.ts). */
export function usePalette(): [Palette | null, (next: Palette) => void] {
  const [palette, setPaletteState] = useState<Palette | null>(() => readStoredPalette());

  useEffect(() => {
    if (palette) {
      document.documentElement.setAttribute('data-palette', palette);
    } else {
      document.documentElement.removeAttribute('data-palette');
    }
  }, [palette]);

  const setPalette = useCallback((next: Palette) => {
    setPaletteState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Per-viewer convenience only; a private window or blocked storage just means the
      // choice doesn't persist across reloads.
    }
  }, []);

  return [palette, setPalette];
}
