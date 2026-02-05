import { expect } from 'chai';
import sinon from 'sinon';

import { OpenSearchBatchProcessor } from '../../../../server/lib/open-search/batch-processor';
import * as OpenSearchClient from '../../../../server/lib/open-search/client';
import { OpenSearchRequestType } from '../../../../server/lib/open-search/types';
import * as SentryLib from '../../../../server/lib/sentry';

describe('server/lib/open-search/batch-processor', () => {
  let processor: OpenSearchBatchProcessor;
  let clientStub;
  let sentryReportMessageStub;
  let sentryReportErrorStub;

  beforeEach(() => {
    // Reset singleton instance
    (OpenSearchBatchProcessor as any).instance = null;

    // Create stub for ES client
    clientStub = {
      bulk: sinon.stub().resolves({ body: { items: [], errors: false, took: 0 } }),
      deleteByQuery: sinon.stub().resolves({ took: 0 }),
    };

    // Mock the ES client
    sinon.stub(OpenSearchClient, 'getOpenSearchClient').returns(clientStub);
    processor = OpenSearchBatchProcessor.getInstance();

    sentryReportMessageStub = sinon.stub(SentryLib, 'reportMessageToSentry');
    sentryReportErrorStub = sinon.stub(SentryLib, 'reportErrorToSentry');
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('addToQueue()', () => {
    it('should add requests to the queue and schedule batch processing', async () => {
      processor.start();
      processor.addToQueue({
        type: OpenSearchRequestType.UPDATE,
        table: 'Collectives',
        payload: { id: 1 },
      });
      processor.addToQueue({
        type: OpenSearchRequestType.INSERT,
        table: 'Collectives',
        payload: { id: 2 },
      });

      expect((processor as any)._queue).to.have.length(2);
      expect(processor.hasScheduledBatch).to.be.true;
    });

    it('should process batch immediately when the queue is full', async () => {
      processor.start();
      const processSpy = sinon.spy(processor, '_processBatch');

      // Fill queue to maxBatchSize
      for (let i = 0; i < processor.maxBatchSize; i++) {
        processor.addToQueue({
          type: OpenSearchRequestType.INSERT,
          table: 'Collectives',
          payload: { id: i }, // Need to have unique payloads to prevent deduplication
        });
      }

      expect(processSpy.calledOnce).to.be.true;
    });

    it('should process batch immediately when RECEIVING a FULL_ACCOUNT_RE_INDEX request', async () => {
      processor.start();
      const processSpy = sinon.spy(processor, '_processBatch');

      processor.addToQueue({
        type: OpenSearchRequestType.FULL_ACCOUNT_RE_INDEX,
        payload: { id: 1 },
      });

      expect(processSpy.calledOnce).to.be.true;
    });

    it('should not add requests when processor is not started', async () => {
      processor.addToQueue({
        type: OpenSearchRequestType.UPDATE,
        table: 'Collectives',
        payload: { id: 1 },
      });

      expect((processor as any)._queue).to.have.length(0);
    });
  });

  describe('flushAndClose()', () => {
    it('should process remaining items and stop accepting new ones', async () => {
      processor.start();
      const processSpy = sinon.spy(processor as any, '_processBatch');

      processor.addToQueue({
        type: OpenSearchRequestType.UPDATE,
        table: 'Collectives',
        payload: { id: 1 },
      });

      await processor.flushAndClose();

      expect(processSpy.calledOnce).to.be.true;
      expect((processor as any)._queue).to.have.length(0);
      expect(processor.hasScheduledBatch).to.be.false;
      expect((processor as any).isProcessing).to.be.false;
    });
  });

  describe('callProcessBatch()', () => {
    it('should wait for existing batch to complete before processing new requests', async () => {
      processor.start();
      const processSpy = sinon.spy(processor as any, '_processBatch');

      // Start a batch processing
      (processor as any).processBatchPromise = Promise.resolve();

      processor.addToQueue({
        type: OpenSearchRequestType.UPDATE,
        table: 'Collectives',
        payload: { id: 1 },
      });

      expect(processSpy.called).to.be.false;
      (processor as any).processBatchPromise = null;

      await (processor as any).callProcessBatch();
      expect(processSpy.calledOnce).to.be.true;
    });

    it('should cancel pending timeout and process immediately', async () => {
      processor.start();
      const processSpy = sinon.spy(processor as any, '_processBatch');

      // Start a batch processing
      (processor as any).processBatchPromise = Promise.resolve();

      processor.addToQueue({
        type: OpenSearchRequestType.UPDATE,
        table: 'Collectives',
        payload: { id: 1 },
      });

      expect(processSpy.called).to.be.false;
      (processor as any).processBatchPromise = null;

      await (processor as any).callProcessBatch(true);
      expect(processSpy.calledOnce).to.be.true;
    });
  });

  describe('preprocessRequests()', () => {
    it('should prioritize FULL_ACCOUNT_RE_INDEX requests', () => {
      const requests = [
        {
          type: OpenSearchRequestType.UPDATE,
          table: 'Collectives',
          payload: { id: 1 },
        },
        {
          type: OpenSearchRequestType.FULL_ACCOUNT_RE_INDEX,
          payload: { id: 1 },
        },
      ];

      const result = (processor as any).preprocessRequests(requests);
      expect(result).to.deep.eq({
        accountsToReIndex: [1],
        requestsGroupedByTableName: {}, // No other requests, because FULL_ACCOUNT_RE_INDEX is prioritized
      });
    });

    it('should group non-reindex requests by table', () => {
      const requests = [
        {
          type: OpenSearchRequestType.UPDATE,
          table: 'Collectives',
          payload: { id: 1 },
        },
        {
          type: OpenSearchRequestType.INSERT,
          table: 'Transactions',
          payload: { id: 2 },
        },
      ];

      const result = (processor as any).preprocessRequests(requests);
      expect(result).to.deep.eq({
        accountsToReIndex: [],
        requestsGroupedByTableName: {
          Collectives: [{ type: OpenSearchRequestType.UPDATE, table: 'Collectives', payload: { id: 1 } }],
          Transactions: [{ type: OpenSearchRequestType.INSERT, table: 'Transactions', payload: { id: 2 } }],
        },
      });
    });

    it('should take the most recent request for each entry', () => {
      const requests = [
        {
          type: OpenSearchRequestType.DELETE,
          table: 'Collectives',
          payload: { id: 1 },
        },
        {
          type: OpenSearchRequestType.UPDATE,
          table: 'Collectives',
          payload: { id: 1 },
        },
      ];

      const result = (processor as any).preprocessRequests(requests);
      expect(result).to.deep.eq({
        accountsToReIndex: [],
        requestsGroupedByTableName: {
          Collectives: [{ type: OpenSearchRequestType.UPDATE, table: 'Collectives', payload: { id: 1 } }],
        },
      });
    });
  });

  describe('_processBatch()', () => {
    it('should handle errors gracefully', async () => {
      processor.start();
      clientStub.bulk.rejects(new Error('Test error'));

      processor.addToQueue({
        type: OpenSearchRequestType.UPDATE,
        table: 'Collectives',
        payload: { id: 1 },
      });

      await (processor as any)._processBatch();

      expect((processor as any).isProcessing).to.be.false;
      expect(sentryReportErrorStub.calledOnce).to.be.true;
    });

    it('should handle bulk response errors', async () => {
      processor.start();
      clientStub.bulk.resolves({ body: { items: [], errors: true, took: 0 } });

      processor.addToQueue({
        type: OpenSearchRequestType.UPDATE,
        table: 'Collectives',
        payload: { id: 1 },
      });

      await (processor as any)._processBatch();

      expect((processor as any).isProcessing).to.be.false;
      expect(sentryReportMessageStub.calledOnce).to.be.true;
    });
  });
});
