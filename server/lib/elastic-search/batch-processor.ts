import { Client } from '@elastic/elasticsearch';

import { getElasticSearchClient } from './client';
import { ElasticSearchRequest } from './types';

// TODO: Queue uniqueness: If there are multiple actions for the same entity, only the last one should be processed

export class ElasticSearchBatchProcessor {
  private static instance: ElasticSearchBatchProcessor;
  private client: Client;
  private queue: ElasticSearchRequest[] = [];
  private maxBatchSize: number = 1_000;
  private maxWaitTimeInSeconds: number = 5_000; // 5 seconds
  private timeoutHandle: NodeJS.Timeout | null = null;

  private constructor() {
    this.client = getElasticSearchClient({ throwIfUnavailable: true });
  }

  static getInstance(): ElasticSearchBatchProcessor {
    if (!ElasticSearchBatchProcessor.instance) {
      ElasticSearchBatchProcessor.instance = new ElasticSearchBatchProcessor();
    }

    return ElasticSearchBatchProcessor.instance;
  }

  async addToQueue(message: ElasticSearchRequest) {
    this.queue.push(message);

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
      // Prepare bulk indexing body
      // TODO: Perform bulk indexing
      // const body = this.queue.flatMap(message => []);
      // const bulkResponse = await this.client.bulk({ ... });

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
    if (this.timeoutHandle) {
      clearTimeout(this.timeoutHandle);
    }

    // TODO: Process queue
    // TODO: Don't accept new messages
  }
}
