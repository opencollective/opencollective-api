/* eslint-disable @typescript-eslint/no-require-imports */

import config from 'config';

import logger from './lib/logger';
import { parseToBoolean } from './lib/utils';

if (parseToBoolean(config.opentelemetry.enabled)) {
  logger.info('opentelemetry tracing enabled');

  const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-proto');
  const { registerInstrumentations } = require('@opentelemetry/instrumentation');
  const { defaultResource, resourceFromAttributes } = require('@opentelemetry/resources');
  const { BatchSpanProcessor } = require('@opentelemetry/sdk-trace-base');
  const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
  const { SequelizeInstrumentation } = require('opentelemetry-instrumentation-sequelize');

  registerInstrumentations({
    instrumentations: [getNodeAutoInstrumentations(), new SequelizeInstrumentation()],
  });

  const collectorTraceExporter = new OTLPTraceExporter({
    url: 'http://localhost:4318/v1/traces',
    concurrencyLimit: 10,
  });

  const provider = new NodeTracerProvider({
    resource: defaultResource().merge(
      resourceFromAttributes({
        'service.name': 'opencollective-api',
      }),
    ),
    spanProcessors: [
      new BatchSpanProcessor(collectorTraceExporter, {
        maxQueueSize: 1000,
        scheduledDelayMillis: 1000,
      }),
    ],
  });

  provider.register();
}
