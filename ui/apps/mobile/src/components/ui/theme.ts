import {
  statusPalette,
  surfacePalette,
  type StatusColors,
  type StatusRole,
  type SurfaceColors,
} from '@boxalarm/design-tokens';
import { useColorScheme } from 'react-native';

export type SurfaceTheme = SurfaceColors & { status: StatusColors };

/** Field defaults to `cab`, matching design.draft.md §1 — the OS scheme is the only switch
 * available on native today (no manual override control exists yet on this surface). */
export function useTheme(): SurfaceTheme {
  const scheme = useColorScheme();
  const palette = scheme === 'light' ? 'day' : 'cab';
  return { ...surfacePalette[palette], status: statusPalette[palette] };
}

export function statusColor(theme: SurfaceTheme, role: StatusRole): string {
  return theme.status[role];
}
