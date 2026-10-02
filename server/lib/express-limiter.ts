// This is a quick port of https://github.com/ded/express-limiter to async Redis
import type express from 'express';
import type { RedisClientType } from 'redis';

type Limit = {
  total: number;
  remaining: number;
  reset: number;
};

type ExpressLimiterLookupFunction = (
  req: express.Request,
  res: express.Response,
  opts: ExpressLimiterOptions,
  next: () => void,
) => void;

type ExpressLimiterOptions = {
  /** Either a dot-separated request path to the key (`remoteUser.id`), or a function resolving it dynamically */
  lookup: string | string[] | ExpressLimiterLookupFunction;
  total?: number;
  expire?: number;
  onRateLimited?: (req: express.Request, res: express.Response, next: express.NextFunction) => void;
  whitelist?: (req: express.Request) => boolean;
  skipHeaders?: boolean;
};

export default function expressLimiter(redisClient: RedisClientType) {
  return function (opts: ExpressLimiterOptions) {
    let middleware = async function (req: express.Request, res: express.Response, next: express.NextFunction) {
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
      // By the time this middleware runs, `opts.lookup` has been resolved to a static key path (see below)
      const staticLookup = opts.lookup as string | string[];
      const lookup: string[] = Array.isArray(staticLookup) ? staticLookup : [staticLookup];

      const lookups = lookup
        .map(item => {
          return `${item}:${item.split('.').reduce(
            (prev, cur) => {
              return prev[cur];
            },
            req as unknown as Record<string, unknown>,
          )}`;
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
        ? (JSON.parse(limit) as Limit)
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
        res.set('X-RateLimit-Limit', String(limit.total));
        res.set('X-RateLimit-Reset', String(Math.ceil(limit.reset / 1000))); // UTC epoch seconds
        res.set('X-RateLimit-Remaining', String(Math.max(limit.remaining, 0)));
      }

      if (limit.remaining >= 0) {
        return next();
      }

      const after = (limit.reset - Date.now()) / 1000;

      if (!opts.skipHeaders) {
        res.set('Retry-After', String(after));
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
