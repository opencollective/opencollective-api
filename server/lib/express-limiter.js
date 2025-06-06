// This is a quick port of https://github.com/ded/express-limiter to async Redis

export default function expressLimiter(redisClient) {
  return function (opts) {
    let middleware = async function (req, res, next) {
      if (opts.whitelist && opts.whitelist(req)) {
        return next();
      }
      opts.onRateLimited =
        typeof opts.onRateLimited === 'function'
          ? opts.onRateLimited
          : function (req, res) {
              res.status(429).send('Rate limit exceeded');
            };

      // Make a local copy to avoid mutations
      const total = opts.total ?? 60;
      const expire = opts.expire ?? 1000 * 60;
      const lookup = Array.isArray(opts.lookup) ? opts.lookup : [opts.lookup];

      const lookups = lookup
        .map(item => {
          return `${item}:${item.split('.').reduce((prev, cur) => {
            return prev[cur];
          }, req)}`;
        })
        .join(':');
      const path = req.path;
      const method = req.method.toLowerCase();
      const key = `ratelimit:${path}:${method}:${lookups}`;
      let limit;
      try {
        limit = await redisClient.get(key);
      } catch {
        // Nothing
      }
      const now = Date.now();
      limit = limit
        ? JSON.parse(limit)
        : {
            total: total,
            remaining: total,
            reset: now + expire,
          };

      if (now > limit.reset) {
        limit.reset = now + expire;
        limit.remaining = total;
      }

      // do not allow negative remaining
      limit.remaining = Math.max(Number(limit.remaining) - 1, -1);
      try {
        await redisClient.set(key, JSON.stringify(limit), { PX: expire });
      } catch {
        // Nothing
      }
      if (!opts.skipHeaders) {
        res.set('X-RateLimit-Limit', limit.total);
        res.set('X-RateLimit-Reset', Math.ceil(limit.reset / 1000)); // UTC epoch seconds
        res.set('X-RateLimit-Remaining', Math.max(limit.remaining, 0));
      }

      if (limit.remaining >= 0) {
        return next();
      }

      const after = (limit.reset - Date.now()) / 1000;

      if (!opts.skipHeaders) {
        res.set('Retry-After', after);
      }

      opts.onRateLimited(req, res, next);
    };

    if (typeof opts.lookup === 'function') {
      const callableLookup = opts.lookup;
      middleware = function (middleware, req, res, next) {
        return callableLookup(req, res, opts, () => {
          return middleware(req, res, next);
        });
      }.bind(this, middleware);
    }

    return middleware;
  };
}
