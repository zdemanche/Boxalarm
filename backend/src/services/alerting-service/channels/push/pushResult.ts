/**
 * Transport-level result and budget helpers, extracted verbatim to @boxalarm/push-transport so
 * the LOB notification push worker shares the HTTP mechanics without importing alerting-service
 * (its isolation sweep forbids that, and rightly so). Re-exported here so every alerting-plane
 * import path is unchanged.
 */
export {
  fetchRetryingConnectionLoss,
  isFetchConnectionLoss,
  isNonRetryableRefusal,
  nextRequestTimeout,
  PUSH_SEND_BUDGET_REQUESTS,
  type PushSendResult,
} from '@boxalarm/push-transport';
