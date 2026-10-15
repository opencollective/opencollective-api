import config from 'config';
import type express from 'express';

import cache from '../lib/cache';
import { EcosystemsRepoSummary, fetchRepoSummary, normalizeRepoKey } from '../lib/ecosystems';
import logger from '../lib/logger';
import RateLimit, { ONE_HOUR_IN_SECONDS } from '../lib/rate-limit';

const REPOSITORY_INFO_CACHE_TTL = ONE_HOUR_IN_SECONDS;

const isValidRepositoryUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
};

export async function getRepositoryInfo(req: express.Request, res: express.Response): Promise<void> {
  const url = req.query.url;
  if (typeof url !== 'string' || !isValidRepositoryUrl(url)) {
    res.status(400).send({ error: { type: 'bad_request', message: 'A valid repository URL is required' } });
    return;
  }

  const rateLimit = new RateLimit(
    `ecosystems_repository_lookup_ip_${req.ip}`,
    config.limits.ecosystems.repositoryLookupsPerHourPerIp,
    ONE_HOUR_IN_SECONDS,
  );

  if (!(await rateLimit.registerCall())) {
    res.status(429).send({
      error: { type: 'rate_limit_exceeded', message: 'Rate limit exceeded. Please try again later.' },
    });
    return;
  }

  const cacheKey = `ecosystems_repository_info_${normalizeRepoKey(url)}`;
  const cachedEntry = await cache.get(cacheKey);
  if (cachedEntry) {
    res.send(cachedEntry);
    return;
  }

  try {
    const entry: EcosystemsRepoSummary = await fetchRepoSummary(url);
    await cache.set(cacheKey, entry, REPOSITORY_INFO_CACHE_TTL);
    res.send(entry);
  } catch (e) {
    logger.error(`Failed to fetch ecosyste.ms repository info for ${url}: ${e.message}`);
    res.status(502).send({
      error: { type: 'bad_gateway', message: 'Failed to fetch the repository information' },
    });
  }
}
