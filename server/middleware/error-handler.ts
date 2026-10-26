import debugLib from 'debug';
import type { NextFunction, Request, Response } from 'express';
import { map } from 'lodash';

import errors from '../lib/errors';
import logger from '../lib/logger';
import { HandlerType, reportErrorToSentry } from '../lib/sentry';

const debug = debugLib('error-handler');

type ExpressError = Error & {
  code?: number;
  status?: number;
  type?: string;
  errors?: { path?: string }[];
};

const isKnownError = (error: Error) => {
  try {
    return Object.values(errors).some(errorClass => error instanceof errorClass);
  } catch {
    debug('isKnownError crash', error, Object.keys(errors), errors);
    return false;
  }
};

/**
 * error handler of the api
 */
export default (err: ExpressError, req: Request, res: Response, next: NextFunction) => {
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
