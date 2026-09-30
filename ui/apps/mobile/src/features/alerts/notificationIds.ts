/** One notification per call: tone 2 replaces tone 1 in the shade instead of stacking. */
export function dispatchNotificationId(dispatchId: string): string {
  return `dispatch:${dispatchId}`;
}

/**
 * The officer's mutual-aid prompt for a call has its own notification: it must never replace the
 * call's page (tone 3 is usually still showing when it arrives), and it opens the prompt, not the
 * alert screen.
 */
export function mutualAidNotificationId(dispatchId: string): string {
  return `mutual-aid:${dispatchId}`;
}
