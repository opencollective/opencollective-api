import { md5 } from '../lib/utils.js';

export function getGraphqlCacheProperties(req) {
  if (req.remoteUser) {
    return;
  }

  // If it's not a GraphQL query with such properties, no cache
  if (!req.body || !req.body.operationName || !req.body.query || !req.body.variables) {
    return;
  }

  // If it's not a GraphQL query, starting with the 'query' keyword, opt-out
  // This implicitely discard mutations, starting with the keyword 'mutation'
  if (!req.body.query.startsWith('query')) {
    return;
  }

  // We don't want to cache a query with such variable
  // Would not be bad right now for security, because the variables are part of the cache key
  if (req.body.variables.draftKey) {
    return;
  }

  // We only want to cache queries with an Account slug
  const slug =
    req.body.variables.slug ||
    req.body.variables.accountSlug ||
    req.body.variables.collectiveSlug ||
    req.body.variables.CollectiveSlug;
  if (!slug) {
    return;
  }

  const queryHash = md5(req.body.query);
  const variablesHash = md5(JSON.stringify(req.body.variables));

  return {
    cacheKey: `${slug}_${req.body.operationName}_${queryHash}_${variablesHash}`,
    cacheSlug: slug,
  };
}
