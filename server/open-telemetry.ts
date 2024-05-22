/* eslint-disable n/no-extraneous-require */
/* eslint-disable n/no-unpublished-require */
/* eslint-disable @typescript-eslint/no-var-requires */

import config from 'config';

import logger from './lib/logger';
import { parseToBoolean } from './lib/utils';

if (parseToBoolean(config.opentelemetry.enabled)) {
  logger.info('opentelemetry tracing enabled');

  const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-proto');
  const { registerInstrumentations } = require('@opentelemetry/instrumentation');
  const { Resource } = require('@opentelemetry/resources');
  const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base');
  const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
  const { SequelizeInstrumentation } = require('opentelemetry-instrumentation-sequelize');

  registerInstrumentations({
    instrumentations: [getNodeAutoInstrumentations(), new SequelizeInstrumentation()],
  });

  const provider = new NodeTracerProvider({
    resource: Resource.default().merge(
      new Resource({
        'service.name': 'opencollective-api',
      }),
    ),
  });

  const collectorTraceExporter = new OTLPTraceExporter({
    url: 'http://localhost:4318/v1/traces',
    concurrencyLimit: 10,
  });

  provider.addSpanProcessor(
    new BatchSpanProcessor(collectorTraceExporter, {
      maxQueueSize: 1000,
      scheduledDelayMillis: 1000,
    }),
  );

  provider.register();
}
