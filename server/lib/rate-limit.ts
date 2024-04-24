import config from 'config';

import { sessionCache } from './cache';

export const ONE_HOUR_IN_SECONDS = 60 * 60;

/**
 * A small wrapper around the cache specialized to handle rate limitings.
 */
export default class RateLimit {
  private cacheKey: string;
  private limit: number;
  private expiryTimeInSeconds: number;
  private ignoreTests: boolean;

  constructor(cacheKey: string, limit: number, expiryTimeInSeconds: number = ONE_HOUR_IN_SECONDS, ignoreTests = false) {
    this.cacheKey = cacheKey;
    this.limit = limit;
    this.expiryTimeInSeconds = expiryTimeInSeconds;
    this.ignoreTests = ignoreTests;
  }

  /** Load the count from cache if required and check if the limit has been reached */
  public async hasReachedLimit(): Promise<boolean> {
    if (
      this.ignoreTests &&
      (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'ci' || config.env === 'e2e')
    ) {
      return false;
    }
    const count = await this.getCallsCount();
    return count >= this.limit;
  }

  /** Register `nbCalls` in the cache. Returns false if limit has been reached. */
  public async registerCall(nbCalls = 1): Promise<boolean> {
    if (
      this.ignoreTests &&
      (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'ci' || config.env === 'e2e')
    ) {
      return true;
    }
    const count = await this.getCallsCount();
    if (count >= this.limit) {
      return false;
    } else {
      await sessionCache.set(this.cacheKey, count + nbCalls, this.expiryTimeInSeconds);
      return true;
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
