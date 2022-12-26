/**
 * This file aims to group all the logic related to the concept of "IContributor".
 *
 * A contributor is a person or an entity that contributes financially or by any other
 * mean to the mission of the collective. While "Member" is dedicated to permissions
 * and can have multiple entries for the same collective (one for BACKER role, one  for ADMIN...etc)
 * contributors should surface only unique collectives.
 */

import { omit } from 'lodash';

import MemberRoles from '../constants/roles';
import { sequelize } from '../models';

import cache from './cache';
import { filterUntil } from './utils';

/**
 * Represent a single contributor.
 */
export interface Contributor {
  id: string;
  name: string;
  roles: Array<MemberRoles>;
  isAdmin: boolean;
  isCore: boolean;
  isBacker: boolean;
  isFundraiser: boolean;
  isIncognito: boolean;
  isGuest: boolean;
  tiersIds: Array<number | null>;
  type: string;
  since: string;
  totalAmountDonated: number;
  description: string | null;
  collectiveSlug: string | null;
  publicMessage: string | null;
  image: string | null;
}

/**
 * An entry in the cache to group contributors for a collective.
 */
interface ContributorsCacheEntry {
  all: ContributorsList;
  tiers: {
    [tierId: string]: ContributorsList;
  };
}

/** An array of contributor */
type ContributorsList = Array<Contributor>;

/** Time in seconds before contributors cache for a collective expires */
const CACHE_VALIDITY = 3600; // 1h

/** A special key to store contributors without tiers */
const CONTRIBUTORS_WITHOUT_TIER_KEY = '__null__';

/** Returns the contributors cache key for this collective */
const getCacheKey = (collectiveId: number): string => {
  return `collective_contributors_${collectiveId}`;
};

/**
 * Store contributors in cache as a `IContributorsCacheEntry`.
 */
const storeContributorsInCache = (collectiveId: number, allContributors: ContributorsList) => {
  const cacheKey = getCacheKey(collectiveId);

  // Store contributors by tier. TierId can be null (we also store contributors without tiers).
  const contributorsByTier = allContributors.reduce((tiers, contributor) => {
    contributor.tiersIds.forEach(tierId => {
      const key = tierId ? tierId.toString() : CONTRIBUTORS_WITHOUT_TIER_KEY;
      if (!tiers[key]) {
        tiers[key] = [contributor];
      } else {
        tiers[key].push(contributor);
      }
    });

    return tiers;
  }, {});

  const cacheEntry: ContributorsCacheEntry = { all: allContributors, tiers: contributorsByTier };
  cache.set(cacheKey, cacheEntry, CACHE_VALIDITY);
  return cacheEntry;
};

const contributorsQuery = `
  SELECT
    c.id,
    c."name",
    c."slug" AS "collectiveSlug",
    c."image",
    c."type",
    MIN(m."since") as "since",
    ARRAY_AGG(DISTINCT m."role") AS "roles",
    ARRAY_AGG(DISTINCT m."TierId") as "tiersIds",
    MAX(m."publicMessage") AS "publicMessage",
    c."isIncognito" as "isIncognito",
    BOOL_OR(COALESCE((c."data" ->> 'isGuest') :: boolean, FALSE)) AS "isGuest",
    COALESCE(MAX(m.description), MAX(tiers.name)) AS "description",
    COALESCE(sum(transactions.amount) / count(DISTINCT m.id), 0) AS "totalAmountDonated"
  FROM
    "Collectives" c
  INNER JOIN "Members" m
    ON m."MemberCollectiveId" = c.id
  LEFT JOIN "Transactions" transactions
    ON transactions."CollectiveId" = :collectiveId
    AND (transactions."FromCollectiveId" = c.id OR transactions."UsingGiftCardFromCollectiveId" = c.id)
    AND transactions."type" = 'CREDIT'
    AND transactions."deletedAt" IS NULL
    AND transactions."RefundTransactionId" IS NULL
  LEFT JOIN "Tiers" tiers
    ON m."TierId" IS NOT NULL AND m."TierId" = tiers.id 
  WHERE
    m."CollectiveId" = :collectiveId
    AND m."MemberCollectiveId" != :collectiveId
    AND m."deletedAt" IS NULL
    AND c."deletedAt" IS NULL
  GROUP BY
    c.id
  ORDER BY
    COALESCE(sum(transactions.amount) / count(DISTINCT m.id), 0) DESC,
    MIN(m."since") ASC
`;

/**
 * Load contributors cache, filling it from DB if necessary.
 */
const loadContributors = async (collectiveId: number): Promise<ContributorsCacheEntry> => {
  const cacheKey = getCacheKey(collectiveId);
  const fromCache = await cache.get(cacheKey);
  if (fromCache) {
    return fromCache;
  }

  // See https://github.com/opencollective/opencollective/issues/4121
  const allContributors = await sequelize.query(contributorsQuery, {
    raw: true,
    type: sequelize.QueryTypes.SELECT,
    replacements: { collectiveId },
  });

  // Pre-fill some properties for contributors so we don't have to re-compute them
  allContributors.forEach((c: Contributor) => {
    // Fill boolean flags for roles to easily check them
    c.isAdmin = c.roles.includes(MemberRoles.ADMIN);
    c.isCore = c.isAdmin || c.roles.includes(MemberRoles.MEMBER);
    c.isBacker = c.roles.includes(MemberRoles.BACKER);
  });

  return storeContributorsInCache(collectiveId, allContributors);
};

/** Accepted params to filters contributors list */
interface ContributorsFilters {
  limit?: number;
  offset?: number;
  roles?: Array<MemberRoles>;
}

type ContributorsFilteringFunc = (contributors: Contributor) => boolean;

/**
 * Provide an optimized function to check the roles of a contributor. Most used filters for
 * roles are BACKER, MEMBER and ADMIN so for most of them we'll only check a boolean.
 */
const getContributorsFilteringFuncForRoles = (roles: Array<MemberRoles>): ContributorsFilteringFunc => {
  const rolesCheckFuncs = roles.map(role => {
    if (role === MemberRoles.BACKER) {
      return c => c.isBacker;
    } else if (role === MemberRoles.ADMIN) {
      return c => c.isAdmin;
    } else if (role === MemberRoles.MEMBER) {
      return c => c.isCore && !c.isAdmin;
    } else {
      return c => c.roles.includes(role);
    }
  });

  // If we're only checking for one role, provide the function directly
  if (rolesCheckFuncs.length === 1) {
    return rolesCheckFuncs[0];
  }

  // Otherwise make sure that at least one role match
  return contributor => rolesCheckFuncs.some(checkFunc => checkFunc(contributor));
};

/**
 * Filter and slice a list of contributors.
 */
const filterContributors = (contributors: ContributorsList, filters: ContributorsFilters | null): ContributorsList => {
  if (!filters) {
    return contributors;
  }

  // Filter by roles
  if (filters.roles && filters.roles.length > 0) {
    const rolesFilterFunc = getContributorsFilteringFuncForRoles(filters.roles);
    if (filters.limit) {
      // No need to filter the full list if we just want to get a few items
      const maxListLength = (filters.offset || 0) + filters.limit;
      contributors = filterUntil(contributors, rolesFilterFunc, list => list.length >= maxListLength);
    } else {
      contributors = contributors.filter(rolesFilterFunc);
    }
  }

  if (filters.offset || filters.limit) {
    return contributors.slice(filters.offset || 0, filters.limit);
  } else {
    return contributors;
  }
};

// ---- Public API ----

/**
 * Returns all the contributors for given collective
 */
export const getContributorsForCollective = async (
  collectiveId: number,
  filters: ContributorsFilters | null,
): Promise<ContributorsList> => {
  const contributorsCache: ContributorsCacheEntry = await loadContributors(collectiveId);
  const contributors = contributorsCache.all || [];
  return filterContributors(contributors, filters);
};

/**
 * Returns all the contributors for given collective
 */
export const getPaginatedContributorsForCollective = async (
  collectiveId: number,
  filters: ContributorsFilters | null,
): Promise<{
  offset: number;
  limit: number;
  totalCount: number;
  nodes: ContributorsList;
}> => {
  const contributorsCache: ContributorsCacheEntry = await loadContributors(collectiveId);
  const contributors = contributorsCache.all || [];
  const filteredContributors = filterContributors(contributors, omit(filters, ['offset', 'limit']));
  return {
    offset: filters?.offset || 0,
    limit: filters?.limit || 0,
    totalCount: filteredContributors.length,
    nodes: !filters ? filteredContributors : filteredContributors.slice(filters.offset || 0, filters.limit),
  };
};

/**
 * Returns all the contributors for given tier
 */
export const getContributorsForTier = async (
  collectiveId: number,
  tierId: number,
  filters: ContributorsFilters | null,
): Promise<ContributorsList> => {
  const contributorsCache: ContributorsCacheEntry = await loadContributors(collectiveId);
  const contributors = contributorsCache.tiers[tierId.toString()] || [];
  return filterContributors(contributors, filters);
};

/**
 * Get all the contributors that are not part of any tier.
 */
export const getContributorsWithoutTier = async (
  collectiveId: number,
  filters: ContributorsFilters | null,
): Promise<ContributorsList> => {
  const contributorsCache: ContributorsCacheEntry = await loadContributors(collectiveId);
  const contributors = contributorsCache[CONTRIBUTORS_WITHOUT_TIER_KEY] || [];
  return filterContributors(contributors, filters);
};

/** Invalidates the contributors cache for this collective */
export const invalidateContributorsCache = async (collectiveId: number): Promise<void> => {
  const cacheKey = getCacheKey(collectiveId);
  return cache.delete(cacheKey);
};
