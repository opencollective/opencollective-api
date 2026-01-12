/* eslint-disable @typescript-eslint/no-require-imports */

import config from 'config';

import logger from './lib/logger';
import { parseToBoolean } from './lib/utils';

const globalScope = globalThis as typeof globalThis & { __ocOpentelemetryStarted?: boolean };
const opentelemetryEnabled = parseToBoolean(config.opentelemetry.enabled);

const initOpenTelemetry = () => {
  if (!opentelemetryEnabled || globalScope.__ocOpentelemetryStarted) {
    return;
  }

  globalScope.__ocOpentelemetryStarted = true;
  if (!process.env.OTEL_SERVICE_NAME) {
    process.env.OTEL_SERVICE_NAME = 'opencollective-api';
  }

  logger.info('opentelemetry tracing enabled');

  const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
  const { SequelizeInstrumentation } = require('@opentelemetry/instrumentation-sequelize');
  const { NodeSDK } = require('@opentelemetry/sdk-node');

  const instrumentations = [getNodeAutoInstrumentations(), new SequelizeInstrumentation()];
  const sdk = new NodeSDK({
    instrumentations,
  });
  Promise.resolve(sdk.start()).catch(error => logger.error('opentelemetry start failed', error));
};

initOpenTelemetry();
