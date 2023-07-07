import debugLib from 'debug';
import { map } from 'lodash';

import errors from '../lib/errors';
import logger from '../lib/logger';
import { HandlerType, reportErrorToSentry } from '../lib/sentry';

const debug = debugLib('error-handler');

const isKnownError = error => {
  try {
    return Object.keys(errors).some(errorClass => error instanceof errors[errorClass]);
  } catch (e) {
    debug('isKnownError crash', error, Object.keys(errors), errors);
    return false;
  }
};

/**
 * error handler of the api
 */
export default (err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  const { name } = err;

  if (name === 'UnauthorizedError') {
    // because of jwt-express
    err.code = err.status;
  }

  res.header('Cache-Control', 'no-cache');

  // Validation error.
  const e = name && name.toLowerCase ? name.toLowerCase() : '';

  if (e.indexOf('validation') !== -1) {
    err = new errors.ValidationFailed(
      null,
      map(err.errors, e => e.path),
      err.message,
    );
  } else if (e.indexOf('uniqueconstraint') !== -1) {
    err = new errors.ValidationFailed(
      null,
      map(err.errors, e => e.path),
      'Unique Constraint Error.',
    );
  }

  if (!err.code || !Number.isInteger(err.code)) {
    const code = err.type && err.type.indexOf('Stripe') > -1 ? 400 : 500;
    err.code = err.status || code;
  }

  logger.error(`Express Error: ${err.message}`);

  // Log unknown errors to Sentry
  if (!isKnownError(err)) {
    try {
      reportErrorToSentry(err, {
        handler: HandlerType.EXPRESS,
        req,
      });
    } catch (e) {
      // Ignore errors from Sentry reporting to make sure we keep returning a real error
      logger.error(`Reporting error to Sentry failed: ${JSON.stringify(e)}`);
    }
  }

  res.status(err.code).send({ error: err });
};
