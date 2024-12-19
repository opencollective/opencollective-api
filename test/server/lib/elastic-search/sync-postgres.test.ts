import { expect } from 'chai';
import sinon from 'sinon';

import { ElasticSearchBatchProcessor } from '../../../../server/lib/elastic-search/batch-processor';
import {
  removeElasticSearchPostgresTriggers,
  startElasticSearchPostgresSync,
  stopElasticSearchPostgresSync,
} from '../../../../server/lib/elastic-search/sync-postgres';
import * as SentryLib from '../../../../server/lib/sentry';
import { fakeCollective, sequelize } from '../../../test-helpers/fake-data';
import { waitForCondition } from '../../../utils';

const checkIfElasticSearchTriggerExists = async () => {
  const [result] = await sequelize.query(`SELECT * FROM pg_trigger WHERE tgname LIKE '%_%_trigger'`);
  return result.length > 0;
};

describe('server/lib/elastic-search/sync-postgres', () => {
  let processorStub;
  let sentryReportMessageStub;
  let sentryReportErrorStub;

  beforeEach(() => {
    processorStub = sinon.createStubInstance(ElasticSearchBatchProcessor);
    sinon.stub(ElasticSearchBatchProcessor, 'getInstance').returns(processorStub);

    sentryReportMessageStub = sinon.stub(SentryLib, 'reportMessageToSentry');
    sentryReportErrorStub = sinon.stub(SentryLib, 'reportErrorToSentry');
  });

  afterEach(async () => {
    sinon.restore();
    await removeElasticSearchPostgresTriggers(); // Make sure we always remove triggers to not impact tests performance
  });

  describe('startElasticSearchPostgresSync', () => {
    let listener;

    afterEach(async () => {
      if (listener) {
        await listener.close();
        listener = null;
      }
    });

    it('should dispatch events to the batch processor', async () => {
      listener = await startElasticSearchPostgresSync();
      await fakeCollective();
      await waitForCondition(() => processorStub.addToQueue.called, { timeout: 2_000 });
      expect(sentryReportMessageStub.calledOnce).to.be.false;
      expect(sentryReportErrorStub.calledOnce).to.be.false;
      expect(await checkIfElasticSearchTriggerExists()).to.be.true;
    });

    it('should report errors to Sentry', async () => {
      listener = await startElasticSearchPostgresSync();
      await listener.notify('elasticsearch-requests', { type: 'INVALID' });
      await waitForCondition(() => sentryReportMessageStub.called, { timeout: 2_000 });
      expect(processorStub.addToQueue.called).to.be.false;
      expect(await checkIfElasticSearchTriggerExists()).to.be.true;
    });
  });

  describe('stopElasticSearchPostgresSync', () => {
    let listener;

    afterEach(async () => {
      if (listener) {
        await listener.close();
        listener = null;
      }
    });

    it('should close connections and flush processor', async () => {
      listener = await startElasticSearchPostgresSync();
      const listenerStopSpy = sinon.spy(listener, 'close');
      await stopElasticSearchPostgresSync();

      expect(processorStub.flushAndClose.calledOnce).to.be.true;
      expect(listenerStopSpy.calledOnce).to.be.true;
      expect(await checkIfElasticSearchTriggerExists()).to.be.false;
    });

    it('should not create multiple shutdown promises', async () => {
      listener = await startElasticSearchPostgresSync();

      const firstStop = stopElasticSearchPostgresSync();
      const secondStop = stopElasticSearchPostgresSync();

      expect(firstStop).to.equal(secondStop);
    });

    it('should timeout if closing takes too long', async () => {});
  });
});
