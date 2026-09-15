export interface MapLinkInput {
  readonly address: string;
  readonly latitude?: number;
  readonly longitude?: number;
}

export function buildMapLink({ address, latitude, longitude }: MapLinkInput): string {
  const query =
    latitude !== undefined && longitude !== undefined ? `${latitude},${longitude}` : address;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}
