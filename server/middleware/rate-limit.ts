import type { NextFunction, Request, Response } from 'express';

import errors from '../lib/errors';
import RateLimit from '../lib/rate-limit';

/**
 * Route-level rate limiter backed by the shared session cache (see `server/lib/rate-limit.ts`).
 * Calls are bucketed by authenticated user when `req.remoteUser` is set, otherwise by client IP,
 * and are counted before the route handler runs (including requests that later fail authorization).
 */
export const rateLimitPerUserOrIp = (keyPrefix: string, limit: number, expiryTimeInSeconds: number) => {
  return async (req: Request, res: Response, next: NextFunction) => {
    const bucket = req.remoteUser ? `user-${req.remoteUser.id}` : `ip-${req.ip}`;
    const rateLimit = new RateLimit(`${keyPrefix}-${bucket}`, limit, expiryTimeInSeconds);
    if (!(await rateLimit.registerCall())) {
      return next(new errors.RateLimitExceeded());
    }

    return next();
  };
};
