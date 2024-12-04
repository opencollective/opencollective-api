import { Client } from '@elastic/elasticsearch';
import { BulkOperationContainer } from '@elastic/elasticsearch/lib/api/types';
import { groupBy } from 'lodash';

import logger from '../logger';

import { getAdapterFromTableName } from './adapters';
import { getElasticSearchClient } from './client';
import { ElasticSearchRequest, ElasticSearchRequestType, isFullAccountReIndexRequest } from './types';

// TODO: Queue uniqueness: If there are multiple actions for the same entity, only the last one should be processed

export class ElasticSearchBatchProcessor {
  private static instance: ElasticSearchBatchProcessor;
  private client: Client;
  private queue: ElasticSearchRequest[] = [];
  private maxBatchSize: number = 1_000;
  private maxWaitTimeInSeconds: number = 5_000; // 5 seconds
  private timeoutHandle: NodeJS.Timeout | null = null;
  private isActive: boolean = true;

  static getInstance(): ElasticSearchBatchProcessor {
    if (!ElasticSearchBatchProcessor.instance) {
      ElasticSearchBatchProcessor.instance = new ElasticSearchBatchProcessor();
    }

    return ElasticSearchBatchProcessor.instance;
  }

  async addToQueue(request: ElasticSearchRequest) {
    if (!this.isActive) {
      logger.warn('Elastic Search Batch Processor received a message after being closed');
      return;
    }

    this.queue.push(request);

    // If we've reached batch size, process immediately
    if (this.queue.length >= this.maxBatchSize) {
      await this.processBatch();
      return;
    }

    // If no timeout is set, create one
    if (!this.timeoutHandle) {
      this.timeoutHandle = setTimeout(async () => {
        await this.processBatch();
      }, this.maxWaitTimeInSeconds);
    }
  }

  async processBatch() {
    // Clear the timeout
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
      this.timeoutHandle = null;
    }

    // Skip if no messages
    if (this.queue.length === 0) {
      return;
    }

    try {
      // TODO Add pagination: only process a subset of the queue

      // Prepare bulk indexing body
      // TODO: Perform bulk indexing
      const operations = this.queue.flatMap(message => []);
      const bulkResponse = await this.client.bulk({ operations });

      // Handle any indexing errors
      // if (bulkResponse.errors) {
      //   console.error(
      //     'Bulk indexing errors:',
      //     bulkResponse.items.filter(item => item.index.status >= 400),
      //   );
      // }

      // Clear the queue after processing
      this.queue = [];
    } catch (error) {
      console.error('Batch processing failed', error);
      // TODO: Optionally implement retry or dead-letter queue logic
    }
  }

  async flushAndClose() {
    this.isActive = false;
    await this.processBatch();
  }

  // ---- Private methods ----
  private constructor() {
    this.client = getElasticSearchClient({ throwIfUnavailable: true });
  }

  private async convertRequestsToBulkIndexingBody(requests: ElasticSearchRequest[]): Promise<BulkOperationContainer[]> {
    const body: BulkOperationContainer[] = [];
    const preparedRequests = this.preprocessRequests(requests);

    for (const [tableOrSpecialAction, requests] of Object.entries(preparedRequests)) {
      if (tableOrSpecialAction === 'FULL_ACCOUNT_RE_INDEX') {
        // TODO: Handle FULL_ACCOUNT_RE_INDEX requests
      } else {
        const adapter = getAdapterFromTableName(tableOrSpecialAction);
        if (!adapter) {
          logger.error(`No ElasticSearch adapter found for table ${tableOrSpecialAction}`);
          continue;
        }

        // Preload all updated entries
        const updateRequests = requests.filter(request => request.type === ElasticSearchRequestType.UPDATE);
        const updateRequestsIds = updateRequests.map(request => request.payload.id);
        const entriesToIndex = await adapter.findEntriesToIndex({ ids: updateRequestsIds });
        const groupedEntriesToIndex = groupBy(entriesToIndex, entry => entry['id']);

        // Iterate over requests and create bulk indexing operations
        for (const request of requests) {
          if (request.type === ElasticSearchRequestType.UPDATE) {
            const entry = groupedEntriesToIndex[request.payload.id];
            if (entry) {
              body.push(
                { index: { _index: adapter.index, _id: request.payload.id.toString() } },
                adapter.mapModelInstanceToDocument(entry),
              );
            } else {
              body.push({ delete: { _index: adapter.index, _id: request.payload.id.toString() } });
            }
          } else if (request.type === ElasticSearchRequestType.DELETE) {
            body.push({ delete: { _index: adapter.index, _id: request.payload.id.toString() } });
          } else if (request.type === ElasticSearchRequestType.TRUNCATE) {
            // TODO
          }
        }
      }
    }

    return body;
  }

  /**
   * Deduplicates requests, returning only the latest request for each entity, unless it's a
   * FULL_ACCOUNT_RE_INDEX request - which always takes maximum priority - then groups them by table.
   */
  private preprocessRequests(requests: ElasticSearchRequest[]): Record<string, ElasticSearchRequest[]> {
    const deduplicatedRequests: Record<number, ElasticSearchRequest> = {};

    for (const request of requests) {
      if (
        isFullAccountReIndexRequest(request) ||
        !isFullAccountReIndexRequest(deduplicatedRequests[request.payload.id])
      ) {
        deduplicatedRequests[request.payload.id] = request;
      }
    }

    return groupBy(Object.values(deduplicatedRequests), request =>
      isFullAccountReIndexRequest(request) ? 'FULL_ACCOUNT_RE_INDEX' : request.table,
    );
  }
}
