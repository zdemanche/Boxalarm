const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

export const MAX_COVERING_CELLS = 64;

export interface BoundingBox {
  readonly minLat: number;
  readonly minLng: number;
  readonly maxLat: number;
  readonly maxLng: number;
}

function validateBoundingBox(bbox: BoundingBox): void {
  if (bbox.minLat >= bbox.maxLat) {
    throw new RangeError(`minLat (${bbox.minLat}) must be less than maxLat (${bbox.maxLat})`);
  }
  if (bbox.minLng >= bbox.maxLng) {
    throw new RangeError(`minLng (${bbox.minLng}) must be less than maxLng (${bbox.maxLng})`);
  }
}

export function encodeGeohash(lat: number, lng: number, precision: number): string {
  let latRange: [number, number] = [-90, 90];
  let lngRange: [number, number] = [-180, 180];
  let isEven = true;
  let bit = 0;
  let charIndex = 0;
  let hash = '';

  while (hash.length < precision) {
    if (isEven) {
      const mid = (lngRange[0] + lngRange[1]) / 2;
      if (lng >= mid) {
        charIndex = (charIndex << 1) | 1;
        lngRange = [mid, lngRange[1]];
      } else {
        charIndex = charIndex << 1;
        lngRange = [lngRange[0], mid];
      }
    } else {
      const mid = (latRange[0] + latRange[1]) / 2;
      if (lat >= mid) {
        charIndex = (charIndex << 1) | 1;
        latRange = [mid, latRange[1]];
      } else {
        charIndex = charIndex << 1;
        latRange = [latRange[0], mid];
      }
    }
    isEven = !isEven;

    if (bit < 4) {
      bit++;
    } else {
      hash += BASE32[charIndex];
      bit = 0;
      charIndex = 0;
    }
  }
  return hash;
}

function cellIndexFor(value: number, origin: number, step: number, maxIndex: number): number {
  const index = Math.floor((value - origin) / step);
  return Math.min(Math.max(index, 0), maxIndex);
}

export function coveringCells(bbox: BoundingBox, precision = 5): string[] {
  validateBoundingBox(bbox);

  const totalBits = precision * 5;
  const lngBits = Math.ceil(totalBits / 2);
  const latBits = Math.floor(totalBits / 2);
  const latStep = 180 / 2 ** latBits;
  const lngStep = 360 / 2 ** lngBits;
  const maxLatIndex = 2 ** latBits - 1;
  const maxLngIndex = 2 ** lngBits - 1;

  const minLatIndex = cellIndexFor(bbox.minLat, -90, latStep, maxLatIndex);
  const maxLatCellIndex = cellIndexFor(bbox.maxLat, -90, latStep, maxLatIndex);
  const minLngIndex = cellIndexFor(bbox.minLng, -180, lngStep, maxLngIndex);
  const maxLngCellIndex = cellIndexFor(bbox.maxLng, -180, lngStep, maxLngIndex);

  const cellCount = (maxLatCellIndex - minLatIndex + 1) * (maxLngCellIndex - minLngIndex + 1);
  if (cellCount > MAX_COVERING_CELLS) {
    throw new RangeError(
      `bbox spans ${cellCount} geohash cells at precision ${precision}, exceeding the maximum of ${MAX_COVERING_CELLS}; narrow the viewport`,
    );
  }

  const cells = new Set<string>();
  for (let latIndex = minLatIndex; latIndex <= maxLatCellIndex; latIndex++) {
    const lat = -90 + (latIndex + 0.5) * latStep;
    for (let lngIndex = minLngIndex; lngIndex <= maxLngCellIndex; lngIndex++) {
      const lng = -180 + (lngIndex + 0.5) * lngStep;
      cells.add(encodeGeohash(lat, lng, precision));
    }
  }

  return Array.from(cells);
}
