/**
 * Lightweight loader utilities for use outside of web/GraphQL context.
 *
 * In the web context, loaders are created per-request via `generateLoaders(req)`.
 * For scripts, cron jobs, and other non-web contexts, use these helpers to get
 * the same loader functionality without needing a request object.
 *
 * Usage:
 *   import { getOrCreateLoaders } from '../lib/loaders';
 *   const loaders = getOrCreateLoaders();
 *   const dates = await loaders.latestCarryforwardDate.buildLoader({ endDate }).loadMany(ids);
 */

import { generateLatestCarryforwardDateLoader } from '../graphql/loaders/transactions';

// Singleton cache for loaders created outside web context
let standaloneLoaders: StandaloneLoaders | null = null;

type StandaloneLoaders = {
  latestCarryforwardDate: ReturnType<typeof generateLatestCarryforwardDateLoader>;
};

/**
 * Get or create standalone loaders for use outside of web context.
 * These loaders are cached as singletons - they persist for the lifetime of the process.
 *
 * Note: In scripts that process many items, the loader cache will grow.
 * For long-running processes, consider calling `resetStandaloneLoaders()` periodically.
 */
export function getOrCreateLoaders(): StandaloneLoaders {
  if (!standaloneLoaders) {
    const cachedLoaders = {};
    standaloneLoaders = {
      latestCarryforwardDate: generateLatestCarryforwardDateLoader(cachedLoaders),
    };
  }
  return standaloneLoaders;
}

/**
 * Reset standalone loaders. Useful for long-running processes to clear cache.
 */
export function resetStandaloneLoaders(): void {
  standaloneLoaders = null;
}
