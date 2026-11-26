/**
 * Settings of the query cost check, shared by the Apollo plugin and the CI report (`scripts/graphql-cost.ts`) so
 * that they cannot disagree on the maximum.
 */
import config from 'config';

import { parseToBoolean } from '../../lib/utils';

/** Used when `GRAPHQL_COST_MAX` is not a positive number. Keep in sync with `config/default.json`. */
const DEFAULT_MAX_QUERY_COST = 50_000_000;

/** `config.graphql.cost`: the maximum cost (`GRAPHQL_COST_MAX`) and whether to reject above it (`GRAPHQL_COST_REJECT`) */
export const getQueryCostSettings = (): { max: number; reject: boolean } => {
  const max = Number(config.graphql.cost?.max);
  return {
    max: Number.isFinite(max) && max > 0 ? max : DEFAULT_MAX_QUERY_COST,
    reject: parseToBoolean(config.graphql.cost?.reject),
  };
};
