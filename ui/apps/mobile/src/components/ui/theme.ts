import {
  accentPalette,
  shellPalette,
  statusPalette,
  surfacePalette,
  type StatusColors,
  type StatusRole,
  type SurfaceColors,
} from '@boxalarm/design-tokens';
import { useColorScheme } from 'react-native';

/** The 2026-10-11 brand layer (docs/design.md §2 amendment), shared with the web console. */
export interface BrandColors {
  /** Which palette resolved: `day` (light) or `cab` (dark). */
  palette: 'day' | 'cab';
  /** Screen background; cards sit on it. */
  canvas: string;
  /** Card fill. */
  card: string;
  /** Text-safe amber, on a card. */
  accent: string;
  /** Bright amber for primary buttons and selected controls, under `onAccentFill`. */
  accentFill: string;
  onAccentFill: string;
  accentSubtle: string;
  onAccentSubtle: string;
  /** Selection marks: 3:1 on card and canvas. */
  indicator: string;
  /** The dark frame - header, tab bar, status area - in both palettes. */
  shell: typeof shellPalette;
}

export type SurfaceTheme = SurfaceColors & BrandColors & { status: StatusColors };

/** The OS scheme is the only switch available on native today (no manual override control
 * exists yet on this surface): `dark` -> `cab`, anything else -> `day`. An unknown (null)
 * scheme resolves to `day`, the same as every screen still on the legacy
 * `scheme === 'dark' ? palette.cab : palette.day` selection, so the tab bar and the screen
 * under it can never disagree (PR #321 review m5). */
export function useTheme(): SurfaceTheme {
  const scheme = useColorScheme();
  const palette = scheme === 'dark' ? 'cab' : 'day';
  const surface = surfacePalette[palette];
  const accent = accentPalette[palette];
  return {
    ...surface,
    palette,
    // Grey canvas with white cards in day; black canvas with lifted dark cards in cab.
    canvas: palette === 'day' ? surface.surface : surface.bg,
    card: palette === 'day' ? surface.bg : surface.surface,
    accent: accent.accent,
    accentFill: accent.fill,
    onAccentFill: accent.onFill,
    accentSubtle: accent.accentSubtle,
    onAccentSubtle: accent.onAccentSubtle,
    indicator: accent.indicator,
    shell: shellPalette,
    status: statusPalette[palette],
  };
}

export function statusColor(theme: SurfaceTheme, role: StatusRole): string {
  return theme.status[role];
}

/** Card elevation: a soft shadow in day; cab relies on the lifted card colour. */
export function cardShadow(theme: SurfaceTheme) {
  return theme.palette === 'cab'
    ? {}
    : {
        shadowColor: '#101114',
        shadowOpacity: 0.08,
        shadowRadius: 6,
        shadowOffset: { width: 0, height: 2 },
        elevation: 2,
      };
}
