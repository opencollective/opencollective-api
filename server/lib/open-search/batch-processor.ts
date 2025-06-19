import { Client } from '@opensearch-project/opensearch';
import { DeleteByQuery_Request as DeleteByQueryRequest } from '@opensearch-project/opensearch/api';
import { BulkByScrollResponseBase } from '@opensearch-project/opensearch/api/_types/_common';
import config from 'config';
import debugLib from 'debug';
import { groupBy, keyBy } from 'lodash';

import logger from '../logger';
import { HandlerType, reportErrorToSentry, reportMessageToSentry } from '../sentry';

import { getAdapterFromTableName, OpenSearchModelsAdapters } from './adapters';
import { getOpenSearchClient } from './client';
import { formatIndexNameForOpenSearch } from './common';
import { OpenSearchIndexName } from './constants';
import { isFullAccountReIndexRequest, OpenSearchRequest, OpenSearchRequestType } from './types';

const debug = debugLib('opensearch-batch-processor');

/**
 * This class processes requests in batches, to reduce the number of requests sent to
 * the server.
 */
export class OpenSearchBatchProcessor {
  public maxBatchSize: number = 1_000;
  private static instance: OpenSearchBatchProcessor;
  private client: Client;
  private _queue: OpenSearchRequest[] = [];
  private _maxWaitTimeInSeconds: number = config.opensearch.maxSyncDelay;
  private _timeoutHandle: NodeJS.Timeout | null = null;
  private _isStarted: boolean = false;
  private _isProcessing: boolean = false;
  private _processBatchPromise: Promise<void> | null = null;

  static getInstance(): OpenSearchBatchProcessor {
    if (!OpenSearchBatchProcessor.instance) {
      OpenSearchBatchProcessor.instance = new OpenSearchBatchProcessor();
    }

    return OpenSearchBatchProcessor.instance;
  }

  start() {
    this._isStarted = true;
  }

  get isProcessing() {
    return this._isProcessing;
  }

  get hasScheduledBatch() {
    return Boolean(this._timeoutHandle);
  }

  async flushAndClose() {
    debug('Flushing and closing OpenSearch Batch Processor');
    this._isStarted = false;
    return this.callProcessBatch();
  }

  addToQueue(request: OpenSearchRequest) {
    if (!this._isStarted) {
      return;
    }

    debug('New request:', request.type, request['table'] || '', request.payload);
    this._queue.push(request);

    if (this._queue.length >= this.maxBatchSize || isFullAccountReIndexRequest(request)) {
      this.callProcessBatch();
    } else {
      this.scheduleCallProcessBatch();
    }
  }

  // ---- Private methods ----
  private constructor() {
    this.client = getOpenSearchClient({ throwIfUnavailable: true });
  }

  private scheduleCallProcessBatch(wait = this._maxWaitTimeInSeconds) {
    if (!this._timeoutHandle) {
      this._timeoutHandle = setTimeout(() => this.callProcessBatch(true), wait);
    }
  }

  /**
   * A wrapper around `processBatch` that either calls it immediately or return a promise that resolves
   * once the batch is fully processed or after a timeout.
   */
  private async callProcessBatch(isTimeout = false): Promise<void> {
    // Scenario 1: we are already processing a batch.
    if (this._processBatchPromise) {
      debug('callProcessBatch: waiting on existing batch processing');
      await this._processBatchPromise;
    }
    // Scenario 2: there is a pending batch processing. We cancel the timeout and run the batch immediately.
    else if (this._timeoutHandle) {
      debug(!isTimeout ? 'callProcessBatch: running batch early' : 'callProcessBatch: running batch after sync delay');
      clearTimeout(this._timeoutHandle);
      this._timeoutHandle = null;
      this._processBatchPromise = this._processBatch();
      await this._processBatchPromise;
    }
    // Scenario 3: there is no pending batch processing and no timeout, but there are requests in the queue.
    else if (this._queue.length) {
      debug('callProcessBatch: running batch now');
      this._processBatchPromise = this._processBatch();
      await this._processBatchPromise;
    }
    // Scenario 4: there is no pending batch processing, no timeout and no requests in the queue. We're done.
    else {
      debug('callProcessBatch: all done');
      return;
    }
  }

  private async _processBatch() {
    // Clear the timeout
    if (this._timeoutHandle) {
      clearTimeout(this._timeoutHandle);
      this._timeoutHandle = null;
    }

    // Skip if no messages
    if (this._queue.length === 0) {
      debug('No messages to process');
      return;
    }

    // Skip if already processing
    if (this._isProcessing) {
      return;
    }

    // Immediately move up to maxBatchSize items from the queue to the processing queue
    this._isProcessing = true;
    const processingQueue = this._queue.splice(0, this.maxBatchSize);
    debug('Processing batch of', processingQueue.length, 'requests');

    try {
      // Prepare bulk indexing body
      const { operations, deleteQuery } = await this.convertRequestsToBulkOperations(processingQueue);
      if (deleteQuery) {
        debug('Running delete query for', deleteQuery.body.query.bool.should[0].bool.must[1].terms._id);
        const deleteQueryResult = await this.client.deleteByQuery(deleteQuery);
        debug('Delete query took', (deleteQueryResult.body as BulkByScrollResponseBase).took, 'ms');
      }

      if (operations.length > 0) {
        const bulkResponse = await this.client.bulk({ body: operations });
        debug('Synchronized', bulkResponse.body.items.length, 'items in', bulkResponse.body.took, 'ms');

        // Handle any indexing errors
        if (bulkResponse.body.errors) {
          reportMessageToSentry('OpenSearchBatchProcessor: Bulk indexing errors', {
            severity: 'warning',
            extra: { processingQueue, bulkResponse },
          });
        }
      }
    } catch (error) {
      debug('Error processing batch:', error);
      reportErrorToSentry(error, {
        handler: HandlerType.OPENSEARCH_SYNC_JOB,
        extra: { processingQueue },
      });
    }

    // End of processing
    this._isProcessing = false;
    this._processBatchPromise = null;

    // If the queue is ready to be processed again, do it
    if (this._queue.length && !this._timeoutHandle) {
      const wait = this._queue.length >= this.maxBatchSize ? 0 : this._maxWaitTimeInSeconds;
      this.scheduleCallProcessBatch(wait);
    }
  }

  private async convertRequestsToBulkOperations(
    requests: OpenSearchRequest[],
  ): Promise<{ operations: Record<string, any>[]; deleteQuery: DeleteByQueryRequest }> {
    const { accountsToReIndex, requestsGroupedByTableName } = this.preprocessRequests(requests);
    const operations: Record<string, any>[] = [];

    let deleteQuery: DeleteByQueryRequest | null = null;
    // Start with FULL_ACCOUNT_RE_INDEX requests
    if (accountsToReIndex.length > 0) {
      deleteQuery = this.getAccountsReIndexDeleteQuery(accountsToReIndex);
      for (const adapter of Object.values(OpenSearchModelsAdapters)) {
        const entriesToIndex = await adapter.findEntriesToIndex({ relatedToCollectiveIds: accountsToReIndex });
        for (const entry of entriesToIndex) {
          operations.push(
            { index: { _index: formatIndexNameForOpenSearch(adapter.index), _id: entry['id'].toString() } },
            adapter.mapModelInstanceToDocument(entry),
          );
        }
      }
    }

    // Then process the rest
    for (const [table, requests] of Object.entries(requestsGroupedByTableName)) {
      const adapter = getAdapterFromTableName(table);
      if (!adapter) {
        logger.error(`No OpenSearch adapter found for table ${table}`);
        continue;
      }

      // Preload all updated entries
      let groupedEntriesToIndex = {};
      const updateRequests = requests.filter(request => request.type === OpenSearchRequestType.UPDATE);
      if (updateRequests.length) {
        const updateRequestsIds = updateRequests.map(request => request.payload.id);
        const entriesToIndex = await adapter.findEntriesToIndex({ ids: updateRequestsIds });
        groupedEntriesToIndex = keyBy(entriesToIndex, 'id');
      }

      // Iterate over requests and create bulk indexing operations
      for (const request of requests) {
        if (request.type === OpenSearchRequestType.UPDATE) {
          const entry = groupedEntriesToIndex[request.payload.id];
          if (!entry) {
            operations.push({
              delete: { _index: formatIndexNameForOpenSearch(adapter.index), _id: request.payload.id.toString() },
            });
          } else {
            operations.push(
              { index: { _index: formatIndexNameForOpenSearch(adapter.index), _id: request.payload.id.toString() } },
              adapter.mapModelInstanceToDocument(entry),
            );
          }
        } else if (request.type === OpenSearchRequestType.DELETE) {
          operations.push({
            delete: { _index: formatIndexNameForOpenSearch(adapter.index), _id: request.payload.id.toString() },
          });
        }
      }
    }

    return { operations, deleteQuery };
  }

  private getAccountsReIndexDeleteQuery(accountIds: Array<number>): DeleteByQueryRequest {
    if (!accountIds.length) {
      return null;
    }

    const allIndexes = Object.values(OpenSearchModelsAdapters).map(adapter => adapter.index);
    return {
      index: allIndexes.map(formatIndexNameForOpenSearch),
      wait_for_completion: true, // eslint-disable-line camelcase
      body: {
        query: {
          bool: {
            should: [
              // Delete all collectives
              {
                bool: {
                  must: [
                    { term: { _index: formatIndexNameForOpenSearch(OpenSearchIndexName.COLLECTIVES) } },
                    { terms: { _id: accountIds } },
                  ],
                },
              },
              // Delete all relationships
              { bool: { must: [{ terms: { HostCollectiveId: accountIds } }] } },
              { bool: { must: [{ terms: { ParentCollectiveId: accountIds } }] } },
              { bool: { must: [{ terms: { FromCollectiveId: accountIds } }] } },
              { bool: { must: [{ terms: { CollectiveId: accountIds } }] } },
            ],
          },
        },
      },
    };
  }

  /**
   * Deduplicates requests, returning only the latest request for each entity, unless it's a
   * FULL_ACCOUNT_RE_INDEX request - which always takes maximum priority - then groups them by table.
   */
  private preprocessRequests(requests: OpenSearchRequest[]): {
    accountsToReIndex: Array<number>;
    requestsGroupedByTableName: Record<string, OpenSearchRequest[]>;
  } {
    const accountsToReIndex = new Set<number>();
    const otherRequests: Record<number, OpenSearchRequest> = {};

    for (const request of requests) {
      if (isFullAccountReIndexRequest(request)) {
        accountsToReIndex.add(request.payload.id);
        delete otherRequests[request.payload.id]; // FULL_ACCOUNT_RE_INDEX requests take priority
      } else if (request.table !== 'Collectives' || !accountsToReIndex.has(request.payload.id)) {
        otherRequests[request.payload.id] = request;
      }
    }

    return {
      accountsToReIndex: Array.from(accountsToReIndex),
      requestsGroupedByTableName: groupBy(Object.values(otherRequests), request => request['table']),
    };
  }
}
