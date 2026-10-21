export const MAX_EPOCH_SECONDS = 4_102_444_800;

export function isPlausibleEpochSeconds(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value < MAX_EPOCH_SECONDS;
}
