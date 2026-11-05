import assert from 'assert';

import config from 'config';

import { sessionCache } from './cache';
import logger from './logger';
import { reportMessageToSentry } from './sentry';
import { parseToBoolean } from './utils';

export const ONE_HOUR_IN_SECONDS = 60 * 60;

const isTestEnvironment =
  process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'ci' || config.env === 'e2e' || config.env === 'ci';
const DISABLE_RATE_LIMITING = parseToBoolean(process.env.DISABLE_RATE_LIMITING);

/**
 * A small wrapper around the cache specialized to handle rate limitings.
 * Counters live in fixed windows of `expiryTimeInSeconds`, starting at the first registered call.
 */
export default class RateLimit {
  /** The cache key this limit is bucketed by. Also identifies the bucket in security logs. */
  public readonly cacheKey: string;
  private limit: number;
  private expiryTimeInSeconds: number;
  private ignoreTests: boolean;

  constructor(cacheKey: string, limit: number, expiryTimeInSeconds: number = ONE_HOUR_IN_SECONDS, ignoreTests = false) {
    // Redis only accepts integer expiries: a rejected one would leave a counter that never expires
    assert(
      Number.isInteger(expiryTimeInSeconds) && expiryTimeInSeconds > 0,
      `Invalid rate limit expiry for ${cacheKey}: ${expiryTimeInSeconds}`,
    );
    this.cacheKey = cacheKey;
    this.limit = limit;
    this.expiryTimeInSeconds = expiryTimeInSeconds;
    this.ignoreTests = ignoreTests;
  }

  private isDisabled(): boolean {
    if (this.ignoreTests && isTestEnvironment) {
      return true;
    } else if (DISABLE_RATE_LIMITING) {
      logger.debug(`Rate limiting is disabled`);
      return true;
    } else {
      return false;
    }
  }

  /**
   * Load the count from cache and check if the limit has been reached. This doesn't register anything, so concurrent
   * requests can all pass it: to enforce the limit, use `registerCall` before the action.
   */
  public async hasReachedLimit(): Promise<boolean> {
    if (this.isDisabled()) {
      return false;
    }

    const count = await this.getCallsCount();
    return count >= this.limit;
  }

  /**
   * Atomically register `nbCalls` in the cache. Returns false if the limit had already been reached.
   * Rejected calls are counted too. The counter was already at the limit, so this only matters if calls are later
   * given back with `unregisterCall`.
   */
  public async registerCall(nbCalls = 1): Promise<boolean> {
    if (this.isDisabled()) {
      return true;
    }

    const count = await sessionCache.increment(this.cacheKey, nbCalls, this.expiryTimeInSeconds);
    if (count === undefined) {
      reportMessageToSentry('Rate limit store is not available, allowing call', {
        severity: 'error',
        extra: { cacheKey: this.cacheKey },
      });
      return true;
    }

    return count - nbCalls < this.limit;
  }

  /** Give back calls registered with `registerCall`, e.g. to only count failed attempts */
  public async unregisterCall(nbCalls = 1): Promise<void> {
    if (this.isDisabled()) {
      return;
    }

    await sessionCache.increment(this.cacheKey, -nbCalls, this.expiryTimeInSeconds);
  }

  // Same as registerCall but throws an error if the limit has been reached
  public async registerCallOrThrow(nbCalls = 1): Promise<void> {
    if (!(await this.registerCall(nbCalls))) {
      throw new Error('Rate limit reached');
    }
  }

  /** Resets the limit */
  public async reset() {
    return sessionCache.delete(this.cacheKey);
  }

  /** Load existing count from cache returns it */
  public async getCallsCount(): Promise<number> {
    return (await sessionCache.get(this.cacheKey)) || 0;
  }
}
