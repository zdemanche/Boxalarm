export const palette = {
  day: {
    background: '#ffffff',
    foreground: '#101114',
    accent: '#C77D28',
    error: '#C41E3A',
    success: '#1F8A4C',
    warning: '#B8860B',
  },
  cab: {
    background: '#0b0b0d',
    foreground: '#d6d8dd',
    accent: '#E8A94A',
    error: '#E05252',
    success: '#4CAF6D',
    warning: '#F0B860',
  },
} as const;

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 40 } as const;

// Generous line-height (>= 1.4) for outdoor-glare and low-light legibility, per N7.3.
export const typography = {
  size: { xs: 12, sm: 14, base: 16, lg: 20, xl: 24, xxl: 32, display: 40 },
  lineHeight: 1.4,
} as const;

// N3.5 baseline: 44x44pt (iOS) / 48x48dp (Android). Oversized applies to the truck-check
// runner and alert-response screens specifically, per architecture.md's explicit callout
// that those are used gloved and in a moving vehicle.
export const touchTarget = {
  baseline: { ios: 44, android: 48 },
  oversized: { ios: 56, android: 60 },
} as const;

export const radius = { default: 8, card: 12 } as const;

export const elevation = {
  level0: { shadowOpacity: 0, shadowRadius: 0, androidElevation: 0 },
  level1: { shadowOpacity: 0.08, shadowRadius: 4, androidElevation: 2 },
  level2: { shadowOpacity: 0.16, shadowRadius: 12, androidElevation: 6 },
} as const;

// Sizes only — the icon set itself (Phosphor) is added where it's first consumed, since it
// pulls in react-native-svg as a peer dependency requiring native linking.
export const iconSize = { sm: 16, md: 24, lg: 32 } as const;

export type PaletteName = keyof typeof palette;

// Widened shape of a single resolved palette (palette.day or palette.cab) — use this, not
// `typeof palette.day`, whenever a value is chosen at runtime (e.g. `scheme === 'dark' ?
// palette.cab : palette.day`), since that expression's type is a union of both literal palette
// types, not either one alone.
export type PaletteColors = Record<keyof (typeof palette)['day'], string>;
