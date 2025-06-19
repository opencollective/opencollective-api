import config from 'config';
import { NextFunction, Request, Response } from 'express';
import { truncate } from 'lodash';

import logger from './logger';
import { timing } from './statsd';
import { parseToBoolean } from './utils';

/**
 * Middleware timing tracking utility for a single request
 */
export class MiddlewareTimingTracker {
  private threshold: number;
  private middlewareTimings: Map<string, number>;
  private req: Express.Request;

  constructor(req: Express.Request) {
    this.threshold = config.log.slowMiddlewareThreshold ?? 100;
    this.middlewareTimings = new Map();
    this.req = req;
  }

  /**
   * Start timing a middleware
   * @param middlewareName - Name of the middleware
   * @returns Function to call when middleware completes
   */
  startTiming(middlewareName: string): () => void {
    const startTime = process.hrtime.bigint();

    return () => {
      const endTime = process.hrtime.bigint();
      const duration = Number(endTime - startTime) / 1e6; // Convert to milliseconds

      // Track timing for this request
      this.middlewareTimings.set(middlewareName, duration);

      // Log slow middleware
      if (duration >= this.threshold) {
        this.logSlowMiddleware(middlewareName, duration);
      }

      // Send to statsd if available
      timing(`middleware.${middlewareName}.duration`, duration);
    };
  }

  /**
   * Log slow middleware execution
   * @param middlewareName - Name of the middleware
   * @param duration - Execution time in milliseconds
   */
  private logSlowMiddleware(middlewareName: string, duration: number): void {
    const userInfo = this.req.remoteUser ? `user:${this.req.remoteUser.id}` : '';
    const userTokenInfo = this.req.userToken ? `userToken:${this.req.userToken.id}` : '';
    const personalTokenInfo = this.req.personalToken ? `token:${this.req.personalToken.id}` : '';
    const apiKeyInfo = this.req.apiKey ? `apiKey:${this.req.apiKey}` : '';
    const ipInfo = this.req.ip ? `ip:${this.req.ip}` : '';
    const identifiers = [userInfo, personalTokenInfo, apiKeyInfo, userTokenInfo, ipInfo].filter(Boolean).join(', ');
    const graphqlOperationName =
      typeof this.req['body']?.operationName === 'string' ? this.req['body'].operationName : '';

    logger.warn(
      `Slow middleware detected: ${middlewareName} took ${duration.toFixed(2)}ms - ${this.req.method} ${this.req.baseUrl}${graphqlOperationName ? ` (GQL ${truncate(graphqlOperationName, { length: 50 })})` : ''} - ${identifiers}`,
    );
  }

  /**
   * Get all middleware timings for this request
   * @returns Map of middleware timings
   */
  getTimings(): Map<string, number> {
    return this.middlewareTimings;
  }

  /**
   * Get timing for a specific middleware
   * @param middlewareName - Name of the middleware
   * @returns Timing in milliseconds or undefined if not found
   */
  getTiming(middlewareName: string): number | undefined {
    return this.middlewareTimings.get(middlewareName);
  }

  /**
   * Clear all timings for this request
   */
  clear(): void {
    this.middlewareTimings.clear();
  }
}

/**
 * Express middleware factory that wraps middleware with timing
 * @param {string} middlewareName - Name of the middleware
 * @param {(req: Request, res: Response, next: NextFunction) => void} middleware - The middleware function to wrap
 * @returns Wrapped middleware function
 */
export function withTiming(
  middlewareName: string,
  middleware: (req: Request, res: Response, next: NextFunction) => void,
) {
  if (!parseToBoolean(config.log.slowMiddleware)) {
    return middleware;
  }

  return (req: Request, res: Response, next: NextFunction) => {
    // Create or get the timing tracker for this request
    if (!req.middlewareTimingTracker) {
      req.middlewareTimingTracker = new MiddlewareTimingTracker(req);
    }

    const endTiming = req.middlewareTimingTracker.startTiming(middlewareName);

    // Call the original middleware
    middleware(req, res, (error?: any) => {
      endTiming();
      next(error);
    });
  };
}
