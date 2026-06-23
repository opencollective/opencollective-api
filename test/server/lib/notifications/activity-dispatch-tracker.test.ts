import { assert, expect } from 'chai';

import {
  disableActivityDispatchTracking,
  enableActivityDispatchTracking,
  getPendingActivityDispatches,
  isActivityDispatchTrackingEnabled,
  trackActivityDispatch,
  waitAllActivityDispatches,
} from '../../../../server/lib/notifications/activity-dispatch-tracker';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

const createDeferred = <T = void>(): Deferred<T> => {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('server/lib/notifications/activity-dispatch-tracker', () => {
  afterEach(() => {
    disableActivityDispatchTracking();
  });

  describe('isActivityDispatchTrackingEnabled', () => {
    it('returns false when tracking has not been enabled', () => {
      expect(isActivityDispatchTrackingEnabled()).to.be.false;
    });

    it('returns true after enableActivityDispatchTracking', () => {
      enableActivityDispatchTracking();
      expect(isActivityDispatchTrackingEnabled()).to.be.true;
    });

    it('returns false after disableActivityDispatchTracking', () => {
      enableActivityDispatchTracking();
      disableActivityDispatchTracking();
      expect(isActivityDispatchTrackingEnabled()).to.be.false;
    });
  });

  describe('getPendingActivityDispatches', () => {
    it('returns an empty set by default', () => {
      expect(getPendingActivityDispatches().size).to.equal(0);
    });

    it('returns the live pending set while tracking is enabled', async () => {
      const deferred = createDeferred();
      enableActivityDispatchTracking();
      trackActivityDispatch(deferred.promise);

      expect(getPendingActivityDispatches().size).to.equal(1);
      expect(getPendingActivityDispatches().has(deferred.promise)).to.be.true;

      deferred.resolve();
      await deferred.promise;

      expect(getPendingActivityDispatches().size).to.equal(0);
    });
  });

  describe('disableActivityDispatchTracking', () => {
    it('clears pending dispatches without waiting for them to settle', async () => {
      const deferred = createDeferred();
      enableActivityDispatchTracking();
      trackActivityDispatch(deferred.promise);

      disableActivityDispatchTracking();

      expect(isActivityDispatchTrackingEnabled()).to.be.false;
      expect(getPendingActivityDispatches().size).to.equal(0);

      deferred.resolve();
      await deferred.promise;
    });
  });

  describe('trackActivityDispatch', () => {
    it('is a no-op when tracking is disabled', async () => {
      const deferred = createDeferred();
      trackActivityDispatch(deferred.promise);

      expect(getPendingActivityDispatches().size).to.equal(0);

      deferred.resolve();
      await deferred.promise;
    });

    it('tracks a pending promise while it is in flight', async () => {
      const deferred = createDeferred();
      enableActivityDispatchTracking();
      trackActivityDispatch(deferred.promise);

      expect(getPendingActivityDispatches().has(deferred.promise)).to.be.true;

      deferred.resolve();
      await deferred.promise;

      expect(getPendingActivityDispatches().has(deferred.promise)).to.be.false;
    });

    it('removes rejected promises from the pending set', async () => {
      const deferred = createDeferred();
      enableActivityDispatchTracking();
      trackActivityDispatch(deferred.promise);

      expect(getPendingActivityDispatches().has(deferred.promise)).to.be.true;

      deferred.reject(new Error('dispatch failed'));

      await expect(deferred.promise).to.be.rejectedWith('dispatch failed');
      expect(getPendingActivityDispatches().has(deferred.promise)).to.be.false;
    });

    it('tracks the same promise only once', () => {
      const deferred = createDeferred();
      enableActivityDispatchTracking();

      trackActivityDispatch(deferred.promise);
      trackActivityDispatch(deferred.promise);

      expect(getPendingActivityDispatches().size).to.equal(1);
    });

    it('tracks multiple independent dispatches concurrently', () => {
      const first = createDeferred();
      const second = createDeferred();
      enableActivityDispatchTracking();

      trackActivityDispatch(first.promise);
      trackActivityDispatch(second.promise);

      expect(getPendingActivityDispatches().size).to.equal(2);
      expect(getPendingActivityDispatches().has(first.promise)).to.be.true;
      expect(getPendingActivityDispatches().has(second.promise)).to.be.true;
    });
  });

  describe('waitAllActivityDispatches', () => {
    it('returns immediately when tracking is disabled', async () => {
      const deferred = createDeferred();
      trackActivityDispatch(deferred.promise);

      await waitAllActivityDispatches();

      expect(getPendingActivityDispatches().size).to.equal(0);
      deferred.resolve();
      await deferred.promise;
    });

    it('returns immediately when there are no pending dispatches', async () => {
      enableActivityDispatchTracking();
      await waitAllActivityDispatches();
      expect(getPendingActivityDispatches().size).to.equal(0);
    });

    it('waits for a single tracked dispatch to complete', async () => {
      const deferred = createDeferred();
      let settled = false;

      enableActivityDispatchTracking();
      trackActivityDispatch(
        deferred.promise.then(() => {
          settled = true;
        }),
      );

      const waitPromise = waitAllActivityDispatches();
      assert.isFalse(settled);

      deferred.resolve();
      await waitPromise;

      expect(settled).to.be.true;
      expect(getPendingActivityDispatches().size).to.equal(0);
    });

    it('waits for multiple tracked dispatches to complete', async () => {
      const first = createDeferred();
      const second = createDeferred();
      const settled: string[] = [];

      enableActivityDispatchTracking();
      trackActivityDispatch(
        first.promise.then(() => {
          settled.push('first');
        }),
      );
      trackActivityDispatch(
        second.promise.then(() => {
          settled.push('second');
        }),
      );

      const waitPromise = waitAllActivityDispatches();
      assert.deepEqual(settled, []);

      first.resolve();
      second.resolve();
      await waitPromise;

      expect(settled).to.have.members(['first', 'second']);
      expect(getPendingActivityDispatches().size).to.equal(0);
    });

    it('does not throw when a tracked dispatch rejects', async () => {
      const deferred = createDeferred();
      enableActivityDispatchTracking();
      trackActivityDispatch(deferred.promise);

      const waitPromise = waitAllActivityDispatches();
      deferred.reject(new Error('dispatch failed'));

      await expect(waitPromise).to.be.fulfilled;
      expect(getPendingActivityDispatches().size).to.equal(0);
    });

    it('waits for dispatches registered while a prior batch is settling', async () => {
      const first = createDeferred();
      const second = createDeferred();
      const settled: string[] = [];

      enableActivityDispatchTracking();
      trackActivityDispatch(
        first.promise.then(() => {
          settled.push('first');
          trackActivityDispatch(
            second.promise.then(() => {
              settled.push('second');
            }),
          );
        }),
      );

      const waitPromise = waitAllActivityDispatches();

      first.resolve();
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(settled, ['first']);

      second.resolve();
      await waitPromise;

      expect(settled).to.deep.equal(['first', 'second']);
      expect(getPendingActivityDispatches().size).to.equal(0);
    });
  });
});
