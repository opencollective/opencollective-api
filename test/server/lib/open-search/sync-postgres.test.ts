import { expect } from 'chai';
import sinon from 'sinon';

import { OpenSearchBatchProcessor } from '../../../../server/lib/open-search/batch-processor';
import {
  removeOpenSearchPostgresTriggers,
  startOpenSearchPostgresSync,
  stopOpenSearchPostgresSync,
} from '../../../../server/lib/open-search/sync-postgres';
import * as SentryLib from '../../../../server/lib/sentry';
import { fakeCollective, sequelize } from '../../../test-helpers/fake-data';
import { stubExport } from '../../../test-helpers/stub-helper';
import { waitForCondition } from '../../../utils';

const checkIfSearchTriggerExists = async () => {
  const [result] = await sequelize.query(`SELECT * FROM pg_trigger WHERE tgname LIKE '%_%_trigger'`);
  return result.length > 0;
};

describe('server/lib/open-search/sync-postgres', () => {
  let processorStub;
  let sentryReportMessageStub;
  let sentryReportErrorStub;

  beforeEach(() => {
    processorStub = sinon.createStubInstance(OpenSearchBatchProcessor);
    stubExport(sinon, OpenSearchBatchProcessor as unknown as Record<string, unknown>, 'getInstance').returns(
      processorStub,
    );

    sentryReportMessageStub = stubExport(sinon, SentryLib, 'reportMessageToSentry');
    sentryReportErrorStub = stubExport(sinon, SentryLib, 'reportErrorToSentry');
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
