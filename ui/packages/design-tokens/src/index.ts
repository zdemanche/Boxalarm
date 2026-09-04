export const palette = {
  day: { background: '#ffffff', foreground: '#101114' },
  cab: { background: '#0b0b0d', foreground: '#d6d8dd' },
} as const;

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 40 } as const;

export type PaletteName = keyof typeof palette;
