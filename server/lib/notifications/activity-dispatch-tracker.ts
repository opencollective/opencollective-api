import { noop } from 'lodash';

let trackingEnabled = false;
const pendingDispatches = new Set<Promise<void>>();

export const isActivityDispatchTrackingEnabled = (): boolean => {
  return trackingEnabled;
};

export const getPendingActivityDispatches = (): Set<Promise<void>> => {
  return pendingDispatches;
};

export const enableActivityDispatchTracking = (): void => {
  trackingEnabled = true;
};

export const disableActivityDispatchTracking = (): void => {
  trackingEnabled = false;
  pendingDispatches.clear();
};

export const trackActivityDispatch = (promise: Promise<void>): void => {
  if (!trackingEnabled) {
    return;
  }
  pendingDispatches.add(promise);
  void promise.finally(() => pendingDispatches.delete(promise));
};

export const waitAllActivityDispatches = async (): Promise<void> => {
  if (!trackingEnabled) {
    return;
  }
  while (pendingDispatches.size > 0) {
    await Promise.allSettled([...pendingDispatches]);
  }
};

/**
 * Track a fire-and-forget promise (e.g. emails sent after an order is processed) so that tests can wait for it
 * with `waitAllActivityDispatches`. The original promise's rejection behavior is left untouched.
 */
export const trackBackgroundWork = (promise: Promise<unknown>): void => {
  trackActivityDispatch(promise.then(noop, noop));
};
