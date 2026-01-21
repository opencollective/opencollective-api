import { expect } from 'chai';
import proxyquire from 'proxyquire';
import sinon from 'sinon';

import { fakeCollective, sequelize } from '../../../test-helpers/fake-data';
import { waitForCondition } from '../../../utils';

const checkIfSearchTriggerExists = async () => {
  const [result] = await sequelize.query(`SELECT * FROM pg_trigger WHERE tgname LIKE '%_%_trigger'`);
  return result.length > 0;
};

describe('server/lib/open-search/sync-postgres', () => {
  let processorStub;
  let sentryReportMessageStub;
  let sentryReportErrorStub;
  let startOpenSearchPostgresSync, stopOpenSearchPostgresSync, removeOpenSearchPostgresTriggers;

  beforeEach(async () => {
    processorStub = {
      addToQueue: sinon.stub(),
      flushAndClose: sinon.stub().resolves(),
    };

    sentryReportMessageStub = sinon.stub();
    sentryReportErrorStub = sinon.stub();

    // Load module with mocked dependencies
    const module = proxyquire('../../../../server/lib/open-search/sync-postgres', {
      '../../../../server/lib/open-search/batch-processor': {
        OpenSearchBatchProcessor: {
          getInstance: () => processorStub,
        },
      },
      '../../../../server/lib/sentry': {
        reportMessageToSentry: sentryReportMessageStub,
        reportErrorToSentry: sentryReportErrorStub,
      },
    });
    startOpenSearchPostgresSync = module.startOpenSearchPostgresSync;
    stopOpenSearchPostgresSync = module.stopOpenSearchPostgresSync;
    removeOpenSearchPostgresTriggers = module.removeOpenSearchPostgresTriggers;
  });

  afterEach(async () => {
    sinon.restore();
    await removeOpenSearchPostgresTriggers(); // Make sure we always remove triggers to not impact tests performance
  });

  describe('startOpenSearchPostgresSync', () => {
    let listener;

    afterEach(async () => {
      if (listener) {
        await listener.close();
        listener = null;
      }
    });

    it('should dispatch events to the batch processor', async () => {
      listener = await startOpenSearchPostgresSync();
      await fakeCollective();
      await waitForCondition(() => processorStub.addToQueue.called, { timeout: 2_000 });
      expect(sentryReportMessageStub.calledOnce).to.be.false;
      expect(sentryReportErrorStub.calledOnce).to.be.false;
      expect(await checkIfSearchTriggerExists()).to.be.true;
    });

    it('should report errors to Sentry', async () => {
      listener = await startOpenSearchPostgresSync();
      await listener.notify('opensearch-requests', { type: 'INVALID' });
      await waitForCondition(() => sentryReportMessageStub.called, { timeout: 2_000 });
      expect(processorStub.addToQueue.called).to.be.false;
      expect(await checkIfSearchTriggerExists()).to.be.true;
    });
  });

  describe('stopOpenSearchPostgresSync', () => {
    let listener;

    afterEach(async () => {
      if (listener) {
        await listener.close();
        listener = null;
      }
    });

    it('should close connections and flush processor', async () => {
      listener = await startOpenSearchPostgresSync();
      const listenerStopSpy = sinon.spy(listener, 'close');
      await stopOpenSearchPostgresSync();

      expect(processorStub.flushAndClose.calledOnce).to.be.true;
      expect(listenerStopSpy.calledOnce).to.be.true;
      expect(await checkIfSearchTriggerExists()).to.be.false;
    });

    it('should not create multiple shutdown promises', async () => {
      listener = await startOpenSearchPostgresSync();

      const firstStop = stopOpenSearchPostgresSync();
      const secondStop = stopOpenSearchPostgresSync();

      expect(firstStop).to.equal(secondStop);
    });

    it('should timeout if closing takes too long', async () => {});
  });
});
