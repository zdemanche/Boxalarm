/** One notification per call: tone 2 replaces tone 1 in the shade instead of stacking. */
export function dispatchNotificationId(dispatchId: string): string {
  return `dispatch:${dispatchId}`;
}
