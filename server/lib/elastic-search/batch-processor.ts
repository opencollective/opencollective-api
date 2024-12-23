import { Client } from '@elastic/elasticsearch';
import { BulkOperationContainer, DeleteByQueryRequest } from '@elastic/elasticsearch/lib/api/types';
import config from 'config';
import debugLib from 'debug';
import { groupBy, keyBy } from 'lodash';

import logger from '../logger';
import { HandlerType, reportErrorToSentry, reportMessageToSentry } from '../sentry';

import { ElasticSearchModelsAdapters, getAdapterFromTableName } from './adapters';
import { getElasticSearchClient } from './client';
import { formatIndexNameForElasticSearch } from './common';
import { ElasticSearchIndexName } from './constants';
import { ElasticSearchRequest, ElasticSearchRequestType, isFullAccountReIndexRequest } from './types';

const debug = debugLib('elasticsearch-batch-processor');

/**
 * This class processes ElasticSearch requests in batches, to reduce the number of requests sent to
 * the server.
 */
export class ElasticSearchBatchProcessor {
  public maxBatchSize: number = 1_000;
  private static instance: ElasticSearchBatchProcessor;
  private client: Client;
  private _queue: ElasticSearchRequest[] = [];
  private _maxWaitTimeInSeconds: number = config.elasticSearch.maxSyncDelay;
  private _timeoutHandle: NodeJS.Timeout | null = null;
  private _isStarted: boolean = false;
  private _isProcessing: boolean = false;
  private _processBatchPromise: Promise<void> | null = null;

  static getInstance(): ElasticSearchBatchProcessor {
    if (!ElasticSearchBatchProcessor.instance) {
      ElasticSearchBatchProcessor.instance = new ElasticSearchBatchProcessor();
    }

    return ElasticSearchBatchProcessor.instance;
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
    debug('Flushing and closing Elastic Search Batch Processor');
    this._isStarted = false;
    return this.callProcessBatch();
  }

  addToQueue(request: ElasticSearchRequest) {
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
    this.client = getElasticSearchClient({ throwIfUnavailable: true });
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
        debug('Running delete query for', deleteQuery.query.bool.should[0].bool.must[1].terms._id);
        const deleteQueryResult = await this.client.deleteByQuery(deleteQuery);
        debug('Delete query took', deleteQueryResult.took, 'ms');
      }

      if (operations.length > 0) {
        const bulkResponse = await this.client.bulk({ operations });
        debug('Synchronized', bulkResponse.items.length, 'items in', bulkResponse.took, 'ms');

        // Handle any indexing errors
        if (bulkResponse.errors) {
          reportMessageToSentry('ElasticSearchBatchProcessor: Bulk indexing errors', {
            severity: 'warning',
            extra: { processingQueue, bulkResponse },
          });
        }
      }
    } catch (error) {
      debug('Error processing batch:', error);
      reportErrorToSentry(error, {
        handler: HandlerType.ELASTICSEARCH_SYNC_JOB,
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
    requests: ElasticSearchRequest[],
  ): Promise<{ operations: BulkOperationContainer[]; deleteQuery: DeleteByQueryRequest }> {
    const { accountsToReIndex, requestsGroupedByTableName } = this.preprocessRequests(requests);
    const operations: BulkOperationContainer[] = [];
    let deleteQuery: DeleteByQueryRequest | null = null;
    // Start with FULL_ACCOUNT_RE_INDEX requests
    if (accountsToReIndex.length > 0) {
      deleteQuery = this.getAccountsReIndexDeleteQuery(accountsToReIndex);
      for (const adapter of Object.values(ElasticSearchModelsAdapters)) {
        const entriesToIndex = await adapter.findEntriesToIndex({ relatedToCollectiveIds: accountsToReIndex });
        for (const entry of entriesToIndex) {
          operations.push(
            { index: { _index: formatIndexNameForElasticSearch(adapter.index), _id: entry['id'].toString() } },
            adapter.mapModelInstanceToDocument(entry),
          );
        }
      }
    }

    // Then process the rest
    for (const [table, requests] of Object.entries(requestsGroupedByTableName)) {
      const adapter = getAdapterFromTableName(table);
      if (!adapter) {
        logger.error(`No ElasticSearch adapter found for table ${table}`);
        continue;
      }

      // Preload all updated entries
      let groupedEntriesToIndex = {};
      const updateRequests = requests.filter(request => request.type === ElasticSearchRequestType.UPDATE);
      if (updateRequests.length) {
        const updateRequestsIds = updateRequests.map(request => request.payload.id);
        const entriesToIndex = await adapter.findEntriesToIndex({ ids: updateRequestsIds });
        groupedEntriesToIndex = keyBy(entriesToIndex, 'id');
      }

      // Iterate over requests and create bulk indexing operations
      for (const request of requests) {
        if (request.type === ElasticSearchRequestType.UPDATE) {
          const entry = groupedEntriesToIndex[request.payload.id];
          if (!entry) {
            operations.push({
              delete: { _index: formatIndexNameForElasticSearch(adapter.index), _id: request.payload.id.toString() },
            });
          } else {
            operations.push(
              { index: { _index: formatIndexNameForElasticSearch(adapter.index), _id: request.payload.id.toString() } },
              adapter.mapModelInstanceToDocument(entry),
            );
          }
        } else if (request.type === ElasticSearchRequestType.DELETE) {
          operations.push({
            delete: { _index: formatIndexNameForElasticSearch(adapter.index), _id: request.payload.id.toString() },
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

    const allIndexes = Object.values(ElasticSearchModelsAdapters).map(adapter => adapter.index);
    return {
      index: allIndexes.map(formatIndexNameForElasticSearch).join(','),
      wait_for_completion: true, // eslint-disable-line camelcase
      query: {
        bool: {
          should: [
            // Delete all collectives
            {
              bool: {
                must: [
                  { term: { _index: formatIndexNameForElasticSearch(ElasticSearchIndexName.COLLECTIVES) } },
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
    };
  }

  /**
   * Deduplicates requests, returning only the latest request for each entity, unless it's a
   * FULL_ACCOUNT_RE_INDEX request - which always takes maximum priority - then groups them by table.
   */
  private preprocessRequests(requests: ElasticSearchRequest[]): {
    accountsToReIndex: Array<number>;
    requestsGroupedByTableName: Record<string, ElasticSearchRequest[]>;
  } {
    const accountsToReIndex = new Set<number>();
    const otherRequests: Record<number, ElasticSearchRequest> = {};

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
