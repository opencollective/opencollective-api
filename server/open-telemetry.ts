/* eslint-disable @typescript-eslint/no-require-imports */

import config from 'config';

import logger from './lib/logger';
import { parseToBoolean } from './lib/utils';

if (parseToBoolean(config.opentelemetry.enabled)) {
  logger.info('opentelemetry tracing enabled');

  const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-proto');
  const { resourceFromAttributes } = require('@opentelemetry/resources');
  const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base');
  const { NodeSDK } = require('@opentelemetry/sdk-node');
  const { SequelizeInstrumentation } = require('@opentelemetry/instrumentation-sequelize');

  const resource = resourceFromAttributes({ 'service.name': 'opencollective-api' });

  const collectorTraceExporter = new OTLPTraceExporter({
    url: 'http://localhost:4318/v1/traces',
    concurrencyLimit: 10,
  });

  const instrumentations = [getNodeAutoInstrumentations(), new SequelizeInstrumentation()];
  const spanProcessor = new BatchSpanProcessor(collectorTraceExporter, {
    maxQueueSize: 1000,
    scheduledDelayMillis: 1000,
  });
  const sdk = new NodeSDK({
    resource,
    instrumentations,
    spanProcessor,
  });
  Promise.resolve(sdk.start()).catch(error => logger.error('opentelemetry start failed', error));
  const shutdown = () => sdk.shutdown();

  const shutdownSignal = async () => {
    try {
      await shutdown();
    } catch (error) {
      logger.warn('opentelemetry shutdown failed', error);
    }
  };

  process.on('SIGTERM', shutdownSignal);
  process.on('SIGINT', shutdownSignal);
}
