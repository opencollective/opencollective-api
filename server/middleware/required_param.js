import errors from '../lib/errors';

/**
 *  Parameters required for a route (POST, GET or headers params)
 */
export default function required(properties) {
  properties = [].slice.call(arguments);
  return requiredOptions({ include: ['query', 'body', 'headers'] }, properties);
}

function requiredOptions(options, properties) {
  return function (req, res, next) {
    const missing = {};
    req.required = req.required || {};

    properties.forEach(prop => {
      let value;
      options.include.forEach(source => {
        if (value || value === false) {
          return;
        }
        value = source ? req[source][prop] : req[prop];
      });

      if ((!value || value === 'null') && value !== false) {
        missing[prop] = `Required field ${prop} missing`;
      } else {
        try {
          // Try to parse if JSON
          value = JSON.parse(value);
        } catch (e) {
          // ignore error: leave value as it is
        }
        req.required[prop] = value;
      }
    });

    const missingProps = Object.keys(missing);
    if (missingProps.length) {
      if (missingProps.indexOf('remoteUser') !== -1) {
        return next(new errors.Unauthorized('User is not authenticated'));
      } else {
        return next(new errors.ValidationFailed('missing_required', missing));
      }
    }

    next();
  };
}
