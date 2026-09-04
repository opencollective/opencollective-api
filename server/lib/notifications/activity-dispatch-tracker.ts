let trackingEnabled = false;
const pendingDispatches = new Set<Promise<unknown>>();

export const isActivityDispatchTrackingEnabled = (): boolean => {
  return trackingEnabled;
};

export const getPendingActivityDispatches = (): Set<Promise<unknown>> => {
  return pendingDispatches;
};

export const enableActivityDispatchTracking = (): void => {
  trackingEnabled = true;
};

export const disableActivityDispatchTracking = (): void => {
  trackingEnabled = false;
  pendingDispatches.clear();
};

export const trackActivityDispatch = (promise: Promise<unknown>): void => {
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
 * with `waitAllActivityDispatches`.
 *
 * No rejection handler is attached to `promise`: when tracking is disabled (production) nothing touches it, and
 * when tracking is enabled the only handler is the `finally` bookkeeping, whose derived promise rejects with the
 * same reason. Either way a failure still surfaces through the process-level `unhandledRejection` handler
 * (see `server/lib/sentry`) exactly as it did before being tracked.
 */
export const trackBackgroundWork = (promise: Promise<unknown>): void => {
  trackActivityDispatch(promise);
};
