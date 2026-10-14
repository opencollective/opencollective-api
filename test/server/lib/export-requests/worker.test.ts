import { expect } from 'chai';
import config from 'config';
import { has } from 'lodash';
import moment from 'moment';
import sinon from 'sinon';

import ActivityTypes from '../../../../server/constants/activities';
import ExportWorker, { EXPORT_PROCESSORS, getRetryBackoffMs } from '../../../../server/lib/export-requests/worker';
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
        const retryClock = sandbox.useFakeTimers({ now: moment.utc().subtract(6, 'minutes').toDate(), toFake: ['Date'] });
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

        const call = ExportWorker.processRequest(exportRequest.id, new AbortController().signal);
        await expect(call).to.be.rejectedWith(`ExportRequest is not ENQUEUED`);
        expect(processTransactionsRequestStub.notCalled).to.be.true;
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
        const request = await createFailedRequest({ ageInMs: 1 * 60_000, retryCount: 0 });

        await ExportWorker.tick();
        await request.reload();

        expect(request.status).to.equal(ExportRequestStatus.FAILED);
        expect(request.data).to.have.property('retryCount', 0);
      });

      it('re-enqueues a request once its backoff window has elapsed', async () => {
        const request = await createFailedRequest({ ageInMs: 6 * 60_000, retryCount: 0 });

        await ExportWorker.tick();
        await request.reload();

        expect(request.status).to.equal(ExportRequestStatus.ENQUEUED);
        expect(request.data).to.have.property('retryCount', 1);
      });

      it('doubles the backoff window for each granted retry', async () => {
        // With 2 retries already granted the window is 5 min * 2^2 = 20 min
        const tooEarly = await createFailedRequest({ ageInMs: 18 * 60_000, retryCount: 2 });
        const ready = await createFailedRequest({ ageInMs: 25 * 60_000, retryCount: 2 });

        await ExportWorker.tick();
        await tooEarly.reload();
        await ready.reload();

        expect(tooEarly.status).to.equal(ExportRequestStatus.FAILED);
        expect(ready.status).to.equal(ExportRequestStatus.ENQUEUED);
        expect(ready.data).to.have.property('retryCount', 3);
      });

      it('caps the backoff window at one hour', () => {
        expect(getRetryBackoffMs(0)).to.equal(5 * 60_000);
        expect(getRetryBackoffMs(1)).to.equal(10 * 60_000);
        expect(getRetryBackoffMs(2)).to.equal(20 * 60_000);
        expect(getRetryBackoffMs(5)).to.equal(60 * 60_000);
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
  }
});
