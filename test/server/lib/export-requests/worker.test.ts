import { expect } from 'chai';
import config from 'config';
import { has } from 'lodash';
import moment from 'moment';
import sinon from 'sinon';

import ExportWorker, { EXPORT_PROCESSORS } from '../../../../server/lib/export-requests/worker';
import { MutexLockError } from '../../../../server/lib/mutex';
import { createRedisClient } from '../../../../server/lib/redis';
import * as SentryLib from '../../../../server/lib/sentry';
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
        const clock = sandbox.useFakeTimers({ now: moment.utc().subtract(5, 'hours').toDate(), toFake: ['Date'] });
        const stuckRequest = await fakeExportRequest({
          status: ExportRequestStatus.PROCESSING,
        });
        clock.restore();
        const activeRequest = await fakeExportRequest({
          status: ExportRequestStatus.PROCESSING,
        });
        const abortedRequest = await fakeExportRequest({
          status: ExportRequestStatus.FAILED,
          data: {
            shouldRetry: true,
          },
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

        expect(stuckRequest.status).to.equal(ExportRequestStatus.ENQUEUED);
        expect(abortedRequest.status).to.equal(ExportRequestStatus.ENQUEUED);
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
        expect(exportRequest.data).to.have.property('retryCount', 1);
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
  }
});
