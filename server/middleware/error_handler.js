import { map } from 'lodash';

import errors from '../lib/errors';
import logger from '../lib/logger';
import { Sentry } from '../sentry';

/**
 * error handler of the api
 */
export default (err, req, res, next) => {
  Sentry.withScope(scope => {
    scope.setExtras({ ip: req.ip });
    scope.setExtras({ headers: req.headers });
    scope.setExtras({ body: req.body });
    scope.setTag('error-type', 'Rest Endpoints');
    scope.setExtras({ params: req.params });
    Sentry.captureMessage(err);

    if (res.headersSent) {
      return next(err);
    }

    const { name } = err;
    scope.setTag('error-name', name);

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
      scope.setTag('code', err.code);
    }

    logger.error(`Express Error: ${err.message}`);

    res.status(err.code).send({ error: err });
  });
};
