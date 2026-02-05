import assert from 'assert';

import config from 'config';
import debugLib from 'debug';
import moment from 'moment';
import PQueue from 'p-queue';

import ExportRequest, { ExportRequestStatus, ExportRequestTypes } from '../../models/ExportRequest';
import { createPostgresListener, removePostgresTriggers, setupPostgresTriggers } from '../db';
import logger from '../logger';
import { lockUntilOrThrow, MutexLockError } from '../mutex';
import { runWithTimeout } from '../promises';
import { HandlerType, reportErrorToSentry } from '../sentry';
import sequelize, { Op } from '../sequelize';

import { processHostedCollectivesRequest, processTransactionsRequest } from './export-csv';
import type { ExportProcessor, NotificationEvent } from './types';

const debug = debugLib('export-requests-worker');

const CHANNEL_NAME = 'export-requests';
const FUNCTION_NAME = 'notify_export_requests_on_change';
const TICK_INTERVAL = 5 * 60_000;
const ABORT_ERROR = 'Process aborted';
const MAX_RETRIES = 3;
const TABLES = [{ tableName: 'ExportRequests', triggerPrefix: 'export_requests' }];
export const EXPORT_PROCESSORS: Record<ExportRequestTypes, ExportProcessor> = {
  [ExportRequestTypes.TRANSACTIONS]: processTransactionsRequest,
  [ExportRequestTypes.HOSTED_COLLECTIVES]: processHostedCollectivesRequest,
} as const;

class ExportWorker {
  shutdownPromise?: Promise<void>;
  subscriber?: ReturnType<typeof createPostgresListener>;
  queue: PQueue;
  controller: AbortController;
  interval: NodeJS.Timeout | null = null;

  constructor() {
    this.queue = new PQueue({ concurrency: config?.exports?.concurrency || 5 });
    this.queue.on('next', () => {
      debug('Queue: task completed, pending tasks:', this.queue.pending, 'queue size:', this.queue.size);
    });
    this.controller = new AbortController();
  }

  validateEvent(event: unknown): event is NotificationEvent {
    debug('Validating event:', event);
    return (
      event &&
      typeof event === 'object' &&
      'type' in event &&
      (event.type === 'INSERT' || event.type === 'UPDATE' || event.type === 'DELETE') &&
      'table' in event &&
      event.table === 'ExportRequests' &&
      'payload' in event &&
      typeof event.payload['id'] === 'number'
    );
  }

  async processRequest(requestId: number, signal: AbortSignal): Promise<void> {
    return await lockUntilOrThrow(`export-request-${requestId}`, async release => {
      const request = await ExportRequest.findByPk(requestId);
      assert(request, 'ExportRequest not found');
      assert(request.status === ExportRequestStatus.ENQUEUED, `ExportRequest is not ENQUEUED`);
      debug('Processing request:', request.id);

      const processor = EXPORT_PROCESSORS[request.type];
      assert(processor, `No processor found for ExportRequest type ${request.type}`);

      const abortHandler = async () => {
        debug(`Processing of export request ${request.id} aborted`);
        this.queue.add(async () => {
          await request.fail(ABORT_ERROR, { shouldRetry: true });
          if (release) {
            await release();
          }
        });
      };
      signal.addEventListener('abort', abortHandler);
      // Update status
      await request.update({ status: ExportRequestStatus.PROCESSING });
      await processor(request, signal).catch(async error => {
        debug(`Error in processor for export request ${request.id}:`, error);
        await request.fail(error.message || 'Unknown error', { shouldRetry: request.data?.retryCount < MAX_RETRIES });
        reportErrorToSentry(error, { handler: HandlerType.EXPORTS_WORKER });
      });
      logger.info(`Export request ${request.id} processed successfully`);
      signal.removeEventListener('abort', abortHandler);
    });
  }

  async makeTask(event: NotificationEvent, signal: AbortSignal): Promise<void> {
    debug('New task started:', event);
    if (event.type === 'INSERT') {
      await this.processRequest(event.payload.id, signal).catch(error => {
        if (error instanceof MutexLockError) {
          debug(`Lock for export request ${event.payload.id} could not be acquired`);
        } else {
          reportErrorToSentry(error, { handler: HandlerType.EXPORTS_WORKER });
        }
      });
    }
  }

  private async checkErroredTasks(): Promise<void> {
    const erroredRequests = await ExportRequest.findAll({
      where: {
        status: ExportRequestStatus.FAILED,
        data: {
          shouldRetry: true,
        },
        updatedAt: { [Op.gt]: moment.utc().subtract(1, 'day').toDate() },
      },
    });
    if (erroredRequests.length === 0) {
      return;
    }
    logger.info(`Export Worker: Found ${erroredRequests.length} errored requests ready to retry`);
    await Promise.all(
      erroredRequests.map(async request =>
        request.update({
          status: ExportRequestStatus.ENQUEUED,
          data: Object.assign({}, request.data, {
            shouldRetry: false,
            retryCount: (request.data?.retryCount || 0) + 1,
          }),
        }),
      ),
    );
  }

  private async checkStuckTasks(): Promise<void> {
    const stuckRequests = await ExportRequest.findAll({
      where: {
        status: ExportRequestStatus.PROCESSING,
        updatedAt: { [Op.lt]: moment.utc().subtract(1, 'hour').toDate() },
      },
    });
    debug(`Found ${stuckRequests.length} stuck requests`);
    if (stuckRequests.length === 0) {
      return;
    }
    logger.info(`Export Worker: Found ${stuckRequests.length} stuck requests, marking them as FAILED`);
    await Promise.all(
      stuckRequests.map(async request => {
        try {
          await lockUntilOrThrow(`export-request-${request.id}`, async () => {
            await request.reload();
            await request.fail('Request stuck in PROCESSING state for over an hour', { shouldRetry: true });
          });
        } catch (error) {
          if (error instanceof MutexLockError) {
            // Ignore lock errors, since this means this request is being processed
          } else {
            logger.error(`Error while marking stuck request ${request.id} as FAILED: ${error.message}`);
            reportErrorToSentry(error, { handler: HandlerType.EXPORTS_WORKER });
          }
        }
      }),
    );
  }

  /**
   * Fallback tick to ensure no requests are missed and to perform periodic maintenance.
   */
  async tick(): Promise<void> {
    logger.info(`Exports Worker Tick: running ${this.queue.pending} tasks, ${this.queue.size} more tasks in the queue`);

    await this.checkStuckTasks();
    await this.checkErroredTasks();

    // If there are no tasks in the queue, fetch some ENQUEUED requests from the DB
    if (this.queue.size === 0) {
      const pendingRequests = await ExportRequest.findAll({
        where: {
          status: ExportRequestStatus.ENQUEUED,
        },
        order: [['updatedAt', 'ASC']],
        limit: 10,
      });
      if (pendingRequests.length === 0) {
        logger.info('Exports Worker Tick: no pending ENQUEUED requests found');
        return;
      }
      logger.info(`Exports Worker Tick: found ${pendingRequests.length} pending ENQUEUED requests`);
      for (const request of pendingRequests) {
        const event: NotificationEvent = { type: 'INSERT', table: 'ExportRequests', payload: { id: request.id } };
        try {
          this.queue.add(({ signal }) => this.makeTask(event, signal), {
            signal: this.controller.signal,
            id: `export-request-${event.payload.id}`,
          });
        } catch (error) {
          reportErrorToSentry(error, { handler: HandlerType.EXPORTS_WORKER });
        }
      }
    }
  }

  async start() {
    delete this.shutdownPromise;
    logger.info('Starting Exports Worker...');
    // Setup DB message queue
    this.subscriber = createPostgresListener();
    this.subscriber.notifications.on(CHANNEL_NAME, (event: NotificationEvent) => {
      if (!this.validateEvent(event)) {
        reportErrorToSentry(new Error('Invalid Export Request'), {
          extra: { event: event },
          handler: HandlerType.EXPORTS_WORKER,
          severity: 'error',
        });
        return;
      }
      try {
        this.queue.add(({ signal }) => this.makeTask(event, signal), {
          signal: this.controller.signal,
          id: `export-request-${event.payload.id}`,
        });
        logger.info(`Queued export request ${event.payload.id} for processing`);
      } catch (error) {
        reportErrorToSentry(error, { handler: HandlerType.EXPORTS_WORKER });
      }
    });

    this.subscriber.events.on('error', error => {
      reportErrorToSentry(error, { handler: HandlerType.EXPORTS_WORKER });
    });

    await this.subscriber.connect();
    await this.subscriber.listenTo(CHANNEL_NAME);

    // Setup postgres triggers
    try {
      await setupPostgresTriggers(sequelize, CHANNEL_NAME, FUNCTION_NAME, TABLES, {
        insertTriggersUpdate: false,
        operations: ['INSERT'],
      });
    } catch (error) {
      logger.error(`Error setting up Postgres triggers: ${JSON.stringify(error)}`);
      reportErrorToSentry(error, { handler: HandlerType.EXPORTS_WORKER });
      throw new Error('Failed to setup Postgres triggers');
    }

    this.interval = setInterval(() => this.tick(), TICK_INTERVAL);
    logger.info('Exports Worker Running');
    this.tick();

    return this.subscriber;
  }

  async stop(): Promise<void> {
    if (!this.shutdownPromise) {
      logger.info('Shutting down Exports Worker <-> Postgres sync job');
      this.shutdownPromise = runWithTimeout(
        (async () => {
          await removePostgresTriggers(sequelize, FUNCTION_NAME, TABLES);
          if (this.interval) {
            clearInterval(this.interval);
          }
          this.controller?.abort();
          this.subscriber?.close?.();
          await this.queue?.onPendingZero();
          logger.info('Exports Worker <-> Postgres sync job shutdown complete');
        })(),
        30_000,
        'Exports Worker <-> Postgres sync job took too long to shutdown, forcing exit',
      );
    }
    return this.shutdownPromise;
  }
}

const singletonWorker = new ExportWorker();

export default singletonWorker;
