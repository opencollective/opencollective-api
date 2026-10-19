import { expect } from 'chai';
import config from 'config';
import { has } from 'lodash';
import moment from 'moment';
import sinon from 'sinon';

import ActivityTypes from '../../../../server/constants/activities';
import ExportWorker, {
  EXPORT_PROCESSORS,
  EXPORT_REQUEST_LOCK_TTL_MS,
  getRetryBackoffMs,
  HEARTBEAT_INTERVAL,
  STUCK_THRESHOLD,
} from '../../../../server/lib/export-requests/worker';
import * as mutexLib from '../../../../server/lib/mutex';
import { MutexLockError } from '../../../../server/lib/mutex';
import { createRedisClient } from '../../../../server/lib/redis';
import * as SentryLib from '../../../../server/lib/sentry';
import Activity from '../../../../server/models/Activity';
import ExportRequest, { ExportRequestStatus, ExportRequestTypes } from '../../../../server/models/ExportRequest';
import { fakeExportRequest, sequelize } from '../../../test-helpers/fake-data';
import { waitForCondition } from '../../../utils';

const checkIfExportTriggerExists = async () => {
  const [result] = await sequelize.query(`SELECT * FROM pg_trigger WHERE tgname LIKE 'export_requests_%_trigger'`);
  return result.length > 0;
};

describe('server/lib/export-requests/worker', () => {
  if (has(config, 'redis.serverUrl')) {
    const clearRedis = async () => {
      const redis = await createRedisClient();
      await redis.flushAll();
    };
    const sandbox = sinon.createSandbox();
    let sentryReportErrorStub;

    beforeEach(async () => {
      await clearRedis();
      sentryReportErrorStub = sandbox.stub(SentryLib, 'reportErrorToSentry');
    });

    afterEach(async () => {
      sandbox.restore();
    });

    describe('start', () => {
      let subscriber: (typeof ExportWorker)['subscriber'];

      afterEach(async () => {
        if (subscriber) {
          await subscriber.close();
          subscriber = null;
        }
      });

      it('should set up triggers and listen to export request events', async () => {
        subscriber = await ExportWorker.start();
        expect(await checkIfExportTriggerExists()).to.be.true;
      });

      it('should start a task on INSERT', async () => {
        const makeTaskSpy = sandbox.spy(ExportWorker, 'makeTask');
        subscriber = await ExportWorker.start();

        await fakeExportRequest();

        await waitForCondition(() => makeTaskSpy.calledWithMatch({ type: 'INSERT' }), {
          timeout: 2_000,
        });
        expect(sentryReportErrorStub.called).to.be.false;
      });

      it('should handle incompatible events', async () => {
        const validateEventSpy = sandbox.spy(ExportWorker, 'validateEvent');
        subscriber = await ExportWorker.start();

        // Trigger an error by sending invalid notification
        await subscriber.notify('export-requests', { invalid: 'data' });

        await waitForCondition(() => sentryReportErrorStub.called, { timeout: 2_000 });
        expect(validateEventSpy.called).to.be.true;
        expect(validateEventSpy.returned(false)).to.be.true;
        expect(sentryReportErrorStub.called).to.be.true;
      });

      it('should start the interval tick', async () => {
        subscriber = await ExportWorker.start();
        expect(ExportWorker.interval).to.not.be.undefined;
        expect(ExportWorker.interval).to.have.property('_destroyed', false);
        expect(ExportWorker.interval).to.have.property('_idleTimeout').that.is.greaterThan(0);
      });
    });

    describe('stop', () => {
      let subscriber: (typeof ExportWorker)['subscriber'];

      afterEach(async () => {
        if (subscriber) {
          await subscriber.close();
          subscriber = null;
        }
      });

      it('should close connections and remove triggers', async () => {
        subscriber = await ExportWorker.start();
        const listenerCloseSpy = sandbox.spy(subscriber, 'close');

        await ExportWorker.stop();

        expect(listenerCloseSpy.calledOnce).to.be.true;
        expect(await checkIfExportTriggerExists()).to.be.false;
      });

      it('should stop the interval tick', async () => {
        await ExportWorker.start();
        expect(ExportWorker.shutdownPromise).to.be.undefined;

        await ExportWorker.stop();
        expect(ExportWorker).to.have.property('shutdownPromise');
        expect(ExportWorker.interval).to.not.be.undefined;
        expect(ExportWorker.interval).to.have.property('_destroyed', true);
      });
    });

    describe('tick', () => {
      beforeEach(async () => {
        await ExportRequest.destroy({ where: {}, force: true });
        await ExportWorker.stop();
        ExportWorker.queue.clear();
      });

      it('should add existing ENQUEUED export requests to queue', async () => {
        const queueAddSpy = sandbox.spy(ExportWorker.queue, 'add');
        const request = await fakeExportRequest({
          status: ExportRequestStatus.ENQUEUED,
        });

        expect(queueAddSpy.notCalled).to.be.true;
        await ExportWorker.tick();

        expect(queueAddSpy.calledWithMatch(sinon.match.any, { id: `export-request-${request.id}` })).to.be.true;
      });

      it('should regenerate stuck and error tasks', async () => {
        const stuckClock = sandbox.useFakeTimers({ now: moment.utc().subtract(5, 'hours').toDate(), toFake: ['Date'] });
        const stuckRequest = await fakeExportRequest({
          status: ExportRequestStatus.PROCESSING,
        });
        stuckClock.restore();
        const retryClock = sandbox.useFakeTimers({
          now: moment.utc().subtract(6, 'minutes').toDate(),
          toFake: ['Date'],
        });
        const abortedRequest = await fakeExportRequest({
          status: ExportRequestStatus.FAILED,
          data: {
            shouldRetry: true,
          },
        });
        retryClock.restore();
        const activeRequest = await fakeExportRequest({
          status: ExportRequestStatus.PROCESSING,
        });
        const failedRequest = await fakeExportRequest({
          status: ExportRequestStatus.FAILED,
          data: {
            shouldRetry: false,
          },
        });

        await ExportWorker.tick();

        await stuckRequest.reload();
        await activeRequest.reload();
        await abortedRequest.reload();
        await failedRequest.reload();

        // Stuck requests are marked FAILED here and only re-enqueued on a later tick, once their backoff window elapsed
        expect(stuckRequest.status).to.equal(ExportRequestStatus.FAILED);
        expect(stuckRequest.data).to.have.property('shouldRetry', true);
        expect(abortedRequest.status).to.equal(ExportRequestStatus.ENQUEUED);
        expect(abortedRequest.data).to.have.property('retryCount', 1);
        expect(activeRequest.status).to.equal(ExportRequestStatus.PROCESSING);
        expect(failedRequest.status).to.equal(ExportRequestStatus.FAILED);
      });
    });

    describe('processEvent', () => {
      it('should process ENQUEUED requests', async () => {
        const processTransactionsRequestStub = sandbox
          .stub(EXPORT_PROCESSORS, ExportRequestTypes.TRANSACTIONS)
          .callsFake(async request => {
            expect(request.status).to.equal(ExportRequestStatus.PROCESSING);
          });
        const exportRequest = await fakeExportRequest({
          status: ExportRequestStatus.ENQUEUED,
          type: ExportRequestTypes.TRANSACTIONS,
        });

        await ExportWorker.processRequest(exportRequest.id, new AbortController().signal);
        expect(processTransactionsRequestStub.calledOnce).to.be.true;
      });

      it('should not process non-ENQUEUED requests', async () => {
        const processTransactionsRequestStub = sandbox.stub(EXPORT_PROCESSORS, ExportRequestTypes.TRANSACTIONS);
        const exportRequest = await fakeExportRequest({
          status: ExportRequestStatus.PROCESSING,
          type: ExportRequestTypes.TRANSACTIONS,
        });

        // The INSERT notification of an already-claimed request is an expected loser race: no processing, no Sentry
        await ExportWorker.makeTask(
          { type: 'INSERT', table: 'ExportRequests', payload: { id: exportRequest.id } },
          new AbortController().signal,
        );
        expect(processTransactionsRequestStub.notCalled).to.be.true;
        expect(sentryReportErrorStub.called).to.be.false;
        await exportRequest.reload();
        expect(exportRequest.status).to.equal(ExportRequestStatus.PROCESSING);
      });

      it('should handle abort signal', async () => {
        let keepProcessing = true;
        const processTransactionsRequestStub = sandbox
          .stub(EXPORT_PROCESSORS, ExportRequestTypes.TRANSACTIONS)
          .callsFake(async () => {
            await waitForCondition(() => keepProcessing !== true, { timeout: 10_000 });
          });

        const exportRequest = await fakeExportRequest({
          status: ExportRequestStatus.ENQUEUED,
          type: ExportRequestTypes.TRANSACTIONS,
        });

        const abortController = new AbortController();
        const processPromise = ExportWorker.processRequest(exportRequest.id, abortController.signal);
        await waitForCondition(() => processTransactionsRequestStub.calledOnce, { timeout: 4_000 });

        abortController.abort();
        setImmediate(() => {
          keepProcessing = false;
        });

        await processPromise;
        await exportRequest.reload();
        expect(exportRequest.status).to.equal(ExportRequestStatus.FAILED);
        expect(exportRequest.data).to.have.property('shouldRetry', true);
        // `retryCount` only counts granted retries (incremented by `checkErroredTasks`), never failures
        expect(exportRequest.data?.retryCount ?? 0).to.equal(0);
        expect(exportRequest.data).to.have.property('error', 'Process aborted');
        expect(exportRequest.data).to.have.property('lastAttemptAt');
      });

      it('should gurantee single processing of requests', async () => {
        let keepProcessing = true;
        const processTransactionsRequestStub = sandbox
          .stub(EXPORT_PROCESSORS, ExportRequestTypes.TRANSACTIONS)
          .callsFake(async () => {
            await waitForCondition(() => keepProcessing !== true, { timeout: 10_000 });
          });

        const exportRequest = await fakeExportRequest({
          status: ExportRequestStatus.ENQUEUED,
          type: ExportRequestTypes.TRANSACTIONS,
        });

        const abortController = new AbortController();
        ExportWorker.processRequest(exportRequest.id, abortController.signal);
        await waitForCondition(() => processTransactionsRequestStub.calledOnce, { timeout: 4_000 });

        const secondCall = ExportWorker.processRequest(exportRequest.id, abortController.signal);
        setImmediate(() => {
          keepProcessing = false;
        });

        await expect(secondCall).to.be.rejectedWith(MutexLockError);
      });
    });

    describe('retry accounting', () => {
      beforeEach(async () => {
        await ExportRequest.destroy({ where: {}, force: true });
        await ExportWorker.stop();
        ExportWorker.queue.clear();
      });

      it('does not increment retryCount in ExportRequest.fail()', async () => {
        const request = await fakeExportRequest();
        await request.fail('Something went wrong', { shouldRetry: true });

        await request.reload();
        expect(request.status).to.equal(ExportRequestStatus.FAILED);
        expect(request.data).to.have.property('error', 'Something went wrong');
        expect(request.data).to.have.property('shouldRetry', true);
        expect(request.data?.retryCount ?? 0).to.equal(0);
      });

      it('grants exactly MAX_RETRIES retries with a single retryCount increment per granted retry', async () => {
        // Start 2 hours in the past so the whole fail -> retry cycle can be aged past the backoff windows
        const clock = sandbox.useFakeTimers({ now: moment.utc().subtract(2, 'hours').toDate(), toFake: ['Date'] });
        try {
          const request = await fakeExportRequest({ status: ExportRequestStatus.ENQUEUED });
          const processorStub = sandbox
            .stub(EXPORT_PROCESSORS, ExportRequestTypes.TRANSACTIONS)
            .rejects(new Error('Export failed'));

          // 1 initial run + 3 retries = 4 runs with MAX_RETRIES = 3
          for (let attempt = 1; attempt <= 4; attempt++) {
            await ExportWorker.processRequest(request.id, new AbortController().signal);
            await request.reload();
            expect(request.status).to.equal(ExportRequestStatus.FAILED);
            expect(request.data).to.have.property('error', 'Export failed');
            // `retryCount` is the number of retries granted so far: failures never increment it
            expect(request.data?.retryCount ?? 0).to.equal(attempt - 1);
            expect(request.data).to.have.property('shouldRetry', attempt < 4);

            // Age the failure past its backoff window before ticking
            clock.tick(45 * 60_000);
            await ExportWorker.tick();
            await request.reload();
            if (attempt < 4) {
              expect(request.status).to.equal(ExportRequestStatus.ENQUEUED);
              expect(request.data).to.have.property('retryCount', attempt); // one increment per granted retry
            } else {
              // Exhausted requests stay terminal: no resurrection
              expect(request.status).to.equal(ExportRequestStatus.FAILED);
            }
          }

          expect(processorStub.callCount).to.equal(4);

          // The failure activity is only created on terminal failure, and the request is never completed
          const failureActivities = await Activity.findAll({
            where: { type: ActivityTypes.EXPORT_REQUEST_FAILED, CollectiveId: request.CollectiveId },
          });
          expect(failureActivities).to.have.length(1);
          const completionActivities = await Activity.findAll({
            where: { type: ActivityTypes.EXPORT_REQUEST_COMPLETED, CollectiveId: request.CollectiveId },
          });
          expect(completionActivities).to.have.length(0);
        } finally {
          clock.restore();
        }
      });
    });

    describe('retry backoff', () => {
      beforeEach(async () => {
        await ExportRequest.destroy({ where: {}, force: true });
        await ExportWorker.stop();
        ExportWorker.queue.clear();
      });

      const createFailedRequest = async ({ ageInMs, retryCount }: { ageInMs: number; retryCount: number }) => {
        const clock = sandbox.useFakeTimers({ now: moment.utc().subtract(ageInMs, 'ms').toDate(), toFake: ['Date'] });
        try {
          return await fakeExportRequest({
            status: ExportRequestStatus.FAILED,
            data: { shouldRetry: true, retryCount, error: 'Export failed' },
          });
        } finally {
          clock.restore();
        }
      };

      it('does not re-enqueue a request before its backoff window has elapsed', async () => {
        const request = await createFailedRequest({ ageInMs: getRetryBackoffMs(0) - 30_000, retryCount: 0 });

        await ExportWorker.tick();
        await request.reload();

        expect(request.status).to.equal(ExportRequestStatus.FAILED);
        expect(request.data).to.have.property('retryCount', 0);
      });

      it('re-enqueues a request once its backoff window has elapsed', async () => {
        const request = await createFailedRequest({ ageInMs: getRetryBackoffMs(0) + 60_000, retryCount: 0 });

        await ExportWorker.tick();
        await request.reload();

        expect(request.status).to.equal(ExportRequestStatus.ENQUEUED);
        expect(request.data).to.have.property('retryCount', 1);
      });

      it('doubles the backoff window for each granted retry', async () => {
        // With 2 retries already granted the window is base * 2^2
        const tooEarly = await createFailedRequest({ ageInMs: getRetryBackoffMs(2) - 60_000, retryCount: 2 });
        const ready = await createFailedRequest({ ageInMs: getRetryBackoffMs(2) + 60_000, retryCount: 2 });

        await ExportWorker.tick();
        await tooEarly.reload();
        await ready.reload();

        expect(tooEarly.status).to.equal(ExportRequestStatus.FAILED);
        expect(ready.status).to.equal(ExportRequestStatus.ENQUEUED);
        expect(ready.data).to.have.property('retryCount', 3);
      });

      it('doubles the backoff window per retry and caps it at one hour', () => {
        expect(getRetryBackoffMs(1)).to.equal(2 * getRetryBackoffMs(0));
        expect(getRetryBackoffMs(2)).to.equal(4 * getRetryBackoffMs(0));
        expect(getRetryBackoffMs(0)).to.be.greaterThan(0);
        expect(getRetryBackoffMs(20)).to.equal(60 * 60_000);
        expect(getRetryBackoffMs(10)).to.equal(60 * 60_000);
      });

      it('keeps the one-day ceiling on retries', async () => {
        const request = await createFailedRequest({ ageInMs: 25 * 60 * 60_000, retryCount: 0 });

        await ExportWorker.tick();
        await request.reload();

        expect(request.status).to.equal(ExportRequestStatus.FAILED);
        expect(request.data).to.have.property('retryCount', 0);
      });

      it('never re-enqueues a request that has exhausted its retries', async () => {
        const request = await createFailedRequest({ ageInMs: 2 * 60 * 60_000, retryCount: 3 });

        await ExportWorker.tick();
        await request.reload();

        expect(request.status).to.equal(ExportRequestStatus.FAILED);
        expect(request.data).to.have.property('retryCount', 3);
      });
    });

    describe('failure transitions', () => {
      beforeEach(async () => {
        await ExportRequest.destroy({ where: {}, force: true });
        await Activity.destroy({ where: {}, force: true });
        await ExportWorker.stop();
        ExportWorker.queue.clear();
      });

      it('settles an aborted attempt with exactly one failure write and a deterministic error', async () => {
        let rejectProcessor: (error: Error) => void;
        const processorStub = sandbox
          .stub(EXPORT_PROCESSORS, ExportRequestTypes.TRANSACTIONS)
          .callsFake(() => new Promise((_, reject) => (rejectProcessor = reject)));
        const failSpy = sandbox.spy(ExportRequest.prototype, 'fail');
        const request = await fakeExportRequest({ status: ExportRequestStatus.ENQUEUED });

        const abortController = new AbortController();
        const processPromise = ExportWorker.processRequest(request.id, abortController.signal);
        await waitForCondition(() => processorStub.calledOnce, { timeout: 4_000 });

        // The abort lands first, then the processor rejects like a real canceled request
        abortController.abort();
        rejectProcessor(new Error('Download canceled'));

        await processPromise;
        await request.reload();
        expect(failSpy.calledOnce).to.be.true;
        expect(request.status).to.equal(ExportRequestStatus.FAILED);
        expect(request.data).to.have.property('error', 'Process aborted');
        expect(request.data).to.have.property('shouldRetry', true);
        expect(request.data?.retryCount ?? 0).to.equal(0);

        const completionActivities = await Activity.findAll({
          where: { type: ActivityTypes.EXPORT_REQUEST_COMPLETED, CollectiveId: request.CollectiveId },
        });
        expect(completionActivities).to.have.length(0);
        // Aborted attempts are expected, not errors
        expect(sentryReportErrorStub.called).to.be.false;
      });

      it('does not complete an aborted attempt even when the processor succeeds', async () => {
        let keepProcessing = true;
        const processorStub = sandbox.stub(EXPORT_PROCESSORS, ExportRequestTypes.TRANSACTIONS).callsFake(async () => {
          await waitForCondition(() => keepProcessing !== true, { timeout: 10_000 });
        });
        const failSpy = sandbox.spy(ExportRequest.prototype, 'fail');
        const request = await fakeExportRequest({ status: ExportRequestStatus.ENQUEUED });

        const abortController = new AbortController();
        const processPromise = ExportWorker.processRequest(request.id, abortController.signal);
        await waitForCondition(() => processorStub.calledOnce, { timeout: 4_000 });

        abortController.abort();
        setImmediate(() => {
          keepProcessing = false;
        });

        await processPromise;
        await request.reload();
        expect(failSpy.calledOnce).to.be.true;
        expect(request.status).to.equal(ExportRequestStatus.FAILED);
        const completionActivities = await Activity.findAll({
          where: { type: ActivityTypes.EXPORT_REQUEST_COMPLETED, CollectiveId: request.CollectiveId },
        });
        expect(completionActivities).to.have.length(0);
      });

      it('keeps an aborted request terminal when retries are exhausted', async () => {
        let rejectProcessor: (error: Error) => void;
        const processorStub = sandbox
          .stub(EXPORT_PROCESSORS, ExportRequestTypes.TRANSACTIONS)
          .callsFake(() => new Promise((_, reject) => (rejectProcessor = reject)));
        const request = await fakeExportRequest({
          status: ExportRequestStatus.ENQUEUED,
          data: { retryCount: 3 },
        });

        const abortController = new AbortController();
        const processPromise = ExportWorker.processRequest(request.id, abortController.signal);
        await waitForCondition(() => processorStub.calledOnce, {
          timeout: 4_000,
          onFailure: () => expect.fail('Processor was not called'),
        });

        abortController.abort();
        rejectProcessor(new Error('Download canceled'));
        await processPromise;
        await request.reload();
        expect(request.status).to.equal(ExportRequestStatus.FAILED);
        expect(request.data).to.have.property('error', 'Process aborted');
        expect(request.data).to.have.property('shouldRetry', false);
        expect(request.data).to.have.property('retryCount', 3);

        // No resurrection: exhausted requests stay terminal even on the next tick
        await ExportWorker.tick();
        await request.reload();
        expect(request.status).to.equal(ExportRequestStatus.FAILED);
      });
    });

    describe('status ownership', () => {
      beforeEach(async () => {
        await ExportRequest.destroy({ where: {}, force: true });
        await Activity.destroy({ where: {}, force: true });
        await ExportWorker.stop();
        ExportWorker.queue.clear();
      });

      it('marks the request COMPLETED and creates the completion activity on success', async () => {
        // The processor only returns its result: the worker is the sole writer of `status`
        sandbox.stub(EXPORT_PROCESSORS, ExportRequestTypes.TRANSACTIONS).resolves();
        const request = await fakeExportRequest({ status: ExportRequestStatus.ENQUEUED });

        await ExportWorker.processRequest(request.id, new AbortController().signal);
        await request.reload();

        expect(request.status).to.equal(ExportRequestStatus.COMPLETED);
        const completionActivities = await Activity.findAll({
          where: { type: ActivityTypes.EXPORT_REQUEST_COMPLETED, CollectiveId: request.CollectiveId },
        });
        expect(completionActivities).to.have.length(1);
        const failureActivities = await Activity.findAll({
          where: { type: ActivityTypes.EXPORT_REQUEST_FAILED, CollectiveId: request.CollectiveId },
        });
        expect(failureActivities).to.have.length(0);
      });
    });

    describe('stuck detection (#8765)', () => {
      beforeEach(async () => {
        await ExportRequest.destroy({ where: {}, force: true });
        await Activity.destroy({ where: {}, force: true });
        await ExportWorker.stop();
        ExportWorker.queue.clear();
      });

      const createStaleProcessingRequest = async ({
        data,
        ageInMs = STUCK_THRESHOLD + 60_000,
      }: { data?: Record<string, unknown>; ageInMs?: number } = {}) => {
        const clock = sandbox.useFakeTimers({ now: moment.utc().subtract(ageInMs, 'ms').toDate(), toFake: ['Date'] });
        try {
          return await fakeExportRequest({ status: ExportRequestStatus.PROCESSING, data });
        } finally {
          clock.restore();
        }
      };

      it('never re-enqueues a PROCESSING request with a fresh heartbeat (#8765)', async () => {
        const request = await fakeExportRequest({ status: ExportRequestStatus.PROCESSING });

        await ExportWorker.tick();
        await request.reload();

        expect(request.status).to.equal(ExportRequestStatus.PROCESSING);
        expect(sentryReportErrorStub.called).to.be.false;
      });

      it('tolerates a delayed heartbeat before declaring a run stuck', async () => {
        // A live run's heartbeat can be a full interval overdue before the threshold must still spare it
        const oneBeatLate = await createStaleProcessingRequest({ ageInMs: HEARTBEAT_INTERVAL + 60_000 });
        const missedBeat = await createStaleProcessingRequest({ ageInMs: 2 * HEARTBEAT_INTERVAL - 60_000 });

        await ExportWorker.tick();
        await oneBeatLate.reload();
        await missedBeat.reload();

        expect(oneBeatLate.status).to.equal(ExportRequestStatus.PROCESSING);
        expect(missedBeat.status).to.equal(ExportRequestStatus.PROCESSING);
      });

      it('keeps the heartbeat, stuck threshold and lock TTL ordered', () => {
        // The threshold must tolerate at least one missed heartbeat and stay under the lock TTL, so a live run
        // is never reaped while it still holds its lock
        expect(STUCK_THRESHOLD).to.be.at.least(2 * HEARTBEAT_INTERVAL);
        expect(EXPORT_REQUEST_LOCK_TTL_MS).to.be.greaterThan(STUCK_THRESHOLD);
      });

      it('fails a stale PROCESSING request and marks it retryable per canRetry', async () => {
        const request = await createStaleProcessingRequest();

        await ExportWorker.tick();
        await request.reload();

        expect(request.status).to.equal(ExportRequestStatus.FAILED);
        expect(request.data).to.have.property(
          'error',
          `Request stuck in PROCESSING state without a heartbeat for over ${STUCK_THRESHOLD / 60_000} minutes`,
        );
        expect(request.data).to.have.property('shouldRetry', true);
        expect(request.data?.retryCount ?? 0).to.equal(0);
      });

      it('fails a stale PROCESSING request without retry when retries are exhausted', async () => {
        const request = await createStaleProcessingRequest({ data: { retryCount: 3 } });

        await ExportWorker.tick();
        await request.reload();

        expect(request.status).to.equal(ExportRequestStatus.FAILED);
        expect(request.data).to.have.property('shouldRetry', false);
        expect(request.data).to.have.property('retryCount', 3);
      });

      it('ignores stuck requests whose lock is held by a live run', async () => {
        const request = await createStaleProcessingRequest();

        // A live run always holds the request lock: the stuck check must yield silently
        await mutexLib.lockUntilOrThrow(`export-request-${request.id}`, async () => {
          await ExportWorker.tick();
        });

        await request.reload();
        expect(request.status).to.equal(ExportRequestStatus.PROCESSING);
        expect(sentryReportErrorStub.called).to.be.false;
      });

      it('does not fail a request that completed between the stuck scan and the lock', async () => {
        const request = await createStaleProcessingRequest();

        // Simulate the live run finishing right before checkStuckTasks gets the lock
        const originalReload = ExportRequest.prototype.reload;
        let interposed = false;
        sandbox.stub(ExportRequest.prototype, 'reload').callsFake(async function (...args) {
          if (!interposed) {
            interposed = true;
            await ExportRequest.update({ status: ExportRequestStatus.COMPLETED }, { where: { id: this.id } });
          }
          return originalReload.call(this, ...args);
        });

        await ExportWorker.tick();
        await request.reload();

        expect(request.status).to.equal(ExportRequestStatus.COMPLETED);
        const failureActivities = await Activity.findAll({
          where: { type: ActivityTypes.EXPORT_REQUEST_FAILED, CollectiveId: request.CollectiveId },
        });
        expect(failureActivities).to.have.length(0);
      });

      it('bumps updatedAt as a processing heartbeat while a request is running (#8765)', async () => {
        let keepProcessing = true;
        const processorStub = sandbox.stub(EXPORT_PROCESSORS, ExportRequestTypes.TRANSACTIONS).callsFake(async () => {
          await waitForCondition(() => keepProcessing !== true, { timeout: 10_000 });
        });
        const request = await fakeExportRequest({ status: ExportRequestStatus.ENQUEUED });
        await request.reload();
        const initialUpdatedAt = request.updatedAt.getTime();

        const clock = sandbox.useFakeTimers({ now: Date.now(), toFake: ['Date', 'setInterval', 'clearInterval'] });
        try {
          const processPromise = ExportWorker.processRequest(request.id, new AbortController().signal);
          await waitForCondition(() => processorStub.calledOnce, { timeout: 4_000 });

          // A long export keeps touching the request so stuck detection never selects it
          clock.tick(HEARTBEAT_INTERVAL);
          await waitForCondition(
            async () => {
              await request.reload();
              return request.updatedAt.getTime() > initialUpdatedAt;
            },
            {
              timeout: 4_000,
              onFailure: () => expect.fail('The processing heartbeat did not bump updatedAt'),
            },
          );
          expect(request.status).to.equal(ExportRequestStatus.PROCESSING);

          keepProcessing = false;
          await processPromise;
          // The heartbeat is not left running once the attempt settles
          expect(clock.countTimers()).to.equal(0);
        } finally {
          clock.restore();
        }
      });

      it('holds export request locks longer than the stuck threshold', async () => {
        const realLockUntilOrThrow = mutexLib.lockUntilOrThrow;
        const lockCalls: Array<{ key: string; options: Parameters<typeof realLockUntilOrThrow>[2] }> = [];
        sandbox.stub(mutexLib, 'lockUntilOrThrow').callsFake((key, until, options) => {
          lockCalls.push({ key, options });
          return realLockUntilOrThrow(key, until, options);
        });
        sandbox.stub(EXPORT_PROCESSORS, ExportRequestTypes.TRANSACTIONS).resolves();
        const request = await fakeExportRequest({ status: ExportRequestStatus.ENQUEUED });

        await ExportWorker.processRequest(request.id, new AbortController().signal);

        expect(lockCalls).to.have.length(1);
        expect(lockCalls[0].key).to.equal(`export-request-${request.id}`);
        // A live run must still hold its lock when the stuck threshold probes it
        expect(lockCalls[0].options.unlockTimeoutMs).to.equal(EXPORT_REQUEST_LOCK_TTL_MS);
        expect(lockCalls[0].options.unlockTimeoutMs).to.be.greaterThan(STUCK_THRESHOLD);
      });
    });
  }
});
