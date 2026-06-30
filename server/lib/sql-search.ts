/**
 * Functions related to search
 */

import assert from 'assert';

import config from 'config';
import type { Request } from 'express';
import express from 'express';
import { Expression, RawBuilder, SelectQueryBuilder, sql } from 'kysely';
import slugify from 'limax';
import { isEmpty, isNil, isUndefined, toString, words } from 'lodash';
import { QueryTypes } from 'sequelize';
import isEmail from 'validator/lib/isEmail';

import { CollectiveType } from '../constants/collectives';
import { MemberRolesForPrivateAccounts } from '../constants/roles';
import { BadRequest, RateLimitExceeded } from '../graphql/errors';
import { ORDER_BY_PSEUDO_FIELDS } from '../graphql/v2/enum/OrderByFieldType';
import {
  AmountRangeInputType,
  getAmountRangeQuery,
  makeConsolidatedBalanceSubquery,
} from '../graphql/v2/input/AmountRangeInput';
import models, { Collective, Op, sequelize } from '../models';

import {
  EntityShortIdPrefix,
  getEntityShortIdPrefix,
  isAnyEntityPublicId,
  isEntityPublicId,
} from './permalink/entity-map';
import { floatAmountToCents } from './currency';
import { canSeePrivateAccount } from './private-accounts';
import RateLimit, { ONE_HOUR_IN_SECONDS } from './rate-limit';
import { removeDiacritics } from './string-utils';

// Returned when there's no result for a search
const EMPTY_SEARCH_RESULT = [[], 0] as const;

const CONSOLIDATED_BALANCE_SUBQUERY = makeConsolidatedBalanceSubquery('c');

/**
 * Returns SQL conditions to filter collectives based on private account visibility rules.
 * Mirrors the logic in `canSeePrivateAccount` (server/graphql/loaders/collective.ts).
 */
const buildPrivateAccountSearchVisibilitySQL = async (
  req?: Request,
): Promise<{ sql: string; privilegedCollectiveIds?: number[] }> => {
  const remoteUser = req?.remoteUser;
  if (!remoteUser) {
    return { sql: 'AND c."isPrivate" IS FALSE ' };
  }

  if (remoteUser.isRoot()) {
    return { sql: '' };
  }

  await remoteUser.populateRoles();
  const privilegedCollectiveIds = Array.from(remoteUser.getCollectiveIdsForRoles(MemberRolesForPrivateAccounts));

  if (privilegedCollectiveIds.length === 0) {
    return { sql: 'AND c."isPrivate" IS FALSE ' };
  }

  return {
    sql: `
    AND (
      c."isPrivate" IS FALSE
      -- User is admin of private collective
      OR c.id IN (:privilegedCollectiveIds)
      -- User is fiscal-host admin of private collective
      OR c."HostCollectiveId" IN (:privilegedCollectiveIds)
      -- User is admin of private collective who owns this event/project
      OR c."ParentCollectiveId" IN (:privilegedCollectiveIds)
      -- User is admin of private collective hosted by this organization
      OR (
        c."type" = '${CollectiveType.ORGANIZATION}'
        AND c."hasHosting" IS TRUE
        AND EXISTS (
          SELECT 1 FROM "Collectives" hosted
          WHERE hosted."HostCollectiveId" = c.id
          AND hosted."deletedAt" IS NULL
          AND hosted."approvedAt" IS NOT NULL
          AND hosted.id IN (:privilegedCollectiveIds)
        )
      )
    ) `,
    privilegedCollectiveIds,
  };
};

/**
 * Search users by email address. `user` must be set because this endpoint is rate
 * limited to prevent abuse.
 *
 * @param {String} email - a valid email address
 * @param {Object} user - the user triggering the search
 */
export const searchCollectivesByEmail = async (
  email,
  user,
  offset = 0,
  limit = 10,
): Promise<readonly [readonly Collective[], number]> => {
  if (!email || !user) {
    return EMPTY_SEARCH_RESULT;
  }

  // Put some rate limiting to users can't use this endpoint to bruteforce emails
  const rateLimit = new RateLimit(
    `user_email_search_${user.id}`,
    config.limits.search.email.perHourPerUser,
    ONE_HOUR_IN_SECONDS,
  );

  if (!(await rateLimit.registerCall())) {
    throw new RateLimitExceeded();
  }

  const replacements = { offset, limit, email };
  const fromAndWhere = `
    FROM "Collectives" c
    INNER JOIN "Users" u ON u."CollectiveId" = c.id
    WHERE c."isIncognito" = FALSE AND c.type = 'USER' AND u.email = :email`;

  const [collectives, countRows] = await Promise.all([
    sequelize.query(
      `
    SELECT c.*
    ${fromAndWhere}
    OFFSET :offset
    LIMIT :limit
    `,
      {
        model: models.Collective,
        mapToModel: true,
        replacements,
      },
    ),
    sequelize.query<{ total: number }>(`SELECT COUNT(*)::int AS total ${fromAndWhere}`, {
      type: QueryTypes.SELECT,
      replacements,
      plain: true,
    }),
  ]);

  return [collectives, countRows.total];
};

/**
 * Trim leading/trailing spaces and remove multiple spaces from the string
 */
const trimSearchTerm = term => {
  return term?.trim().replace(/\s+/g, ' ');
};

/**
 * Sanitize a search string to be used in a SQL query
 *
 * Examples: "   crème     brulée => "creme brulee"
 *
 */
const sanitizeSearchTermForTSQuery = term => {
  return removeDiacritics(term)
    .replace(/[^a-zA-Z0-9-\/_. ]/g, '')
    .trim();
};

/**
 * Removes special ILIKE characters like `%
 */
export const sanitizeSearchTermForILike = term => {
  return term.replace(/(_|%|\\)/g, '\\$1');
};

export const getSearchTermSQLConditions = (term: string, collectiveTable?: string, isRoot = false) => {
  let tsQueryFunc, tsQueryArg;
  let sqlConditions = '';
  let sanitizedTerm = '';
  let sanitizedTermNoWhitespaces = '';
  let sanitizedTermForILike = '';
  let sanitizedTermNoWhitespacesForILike = '';
  const trimmedTerm = trimSearchTerm(term);
  const getField = field => (collectiveTable ? `${collectiveTable}."${field}"` : `"${field}"`);
  if (trimmedTerm?.length > 0) {
    // Cleanup term
    const splitTerm = trimmedTerm.split(' ');
    if (term[0] === '@' && splitTerm.length === 1) {
      // When the search starts with a `@`, we search by slug only
      sanitizedTerm = sanitizeSearchTermForILike(removeDiacritics(trimmedTerm).replace(/^@+/, ''));
      sanitizedTermForILike = sanitizedTerm;
      sqlConditions = `AND ${getField('slug')} ILIKE :sanitizedTerm || '%' `;
    } else if (isRoot && splitTerm.length === 1 && isEmail(trimmedTerm)) {
      sanitizedTerm = trimmedTerm.toLowerCase();
      sanitizedTermForILike = sanitizeSearchTermForILike(sanitizedTerm);
      sqlConditions = `AND EXISTS (SELECT id FROM "Users" WHERE "deletedAt" IS NULL AND email = :sanitizedTerm AND "CollectiveId" = ${getField('id')})`;
    } else {
      sanitizedTerm = splitTerm.length === 1 ? sanitizeSearchTermForTSQuery(trimmedTerm) : trimmedTerm;
      sanitizedTermNoWhitespaces = sanitizedTerm.replace(/\s/g, '');
      sanitizedTermForILike = sanitizeSearchTermForILike(sanitizedTerm);
      sanitizedTermNoWhitespacesForILike = sanitizeSearchTermForILike(sanitizedTermNoWhitespaces);
      // Only search for existing term
      if (sanitizedTerm) {
        if (splitTerm.length === 1) {
          tsQueryFunc = 'to_tsquery';
          tsQueryArg = `concat(:sanitizedTerm, ':*')`;
          sqlConditions = `AND ${getField('searchTsVector')} @@ to_tsquery('simple', concat(:sanitizedTerm, ':*'))`;
        } else {
          // Search terms with more than word (seperated by spaces) should be searched for
          // both with and without the spaces.
          // Eg. The collective named BossaNova should be able to be found by searching
          // either "BossaNova" OR "Bossa Nova"
          tsQueryFunc = 'websearch_to_tsquery';
          tsQueryArg = ':sanitizedTerm';
          sqlConditions = `
          AND (${getField('searchTsVector')} @@ websearch_to_tsquery('english', :sanitizedTerm)
          OR ${getField('searchTsVector')} @@ websearch_to_tsquery('simple', :sanitizedTerm)
          OR ${getField('searchTsVector')} @@ websearch_to_tsquery('english', :sanitizedTermNoWhitespaces)
          OR ${getField('searchTsVector')} @@ websearch_to_tsquery('simple', :sanitizedTermNoWhitespaces))`;
        }
      }
    }
  }

  return {
    sqlConditions,
    tsQueryArg,
    tsQueryFunc,
    sanitizedTerm,
    sanitizedTermNoWhitespaces,
    sanitizedTermForILike,
    sanitizedTermNoWhitespacesForILike,
  };
};

const getSortSubQuery = (
  searchTermConditions,
  orderBy: { field?: string | ORDER_BY_PSEUDO_FIELDS; direction?: string } = null,
) => {
  const sortSubQueries = {
    [ORDER_BY_PSEUDO_FIELDS.ACTIVITY]: {
      query: `COALESCE(transaction_stats."count", 0)`,
      requiredJoin: 'transaction_stats',
    },
    [ORDER_BY_PSEUDO_FIELDS.LAST_TRANSACTION_CREATED_AT]: {
      query: `COALESCE(transaction_stats."LatestTransactionCreatedAt", '2015-11-23')`,
      requiredJoin: 'transaction_stats',
    },
    [ORDER_BY_PSEUDO_FIELDS.RANK]: {
      query: `
      CASE WHEN (c."slug" = :slugifiedTerm OR c."name" ILIKE :sanitizedTermForILike)
        THEN 1
        ELSE
          ${
            searchTermConditions.tsQueryFunc
              ? `ts_rank(c."searchTsVector", ${searchTermConditions.tsQueryFunc}('english', ${searchTermConditions.tsQueryArg}), 1)`
              : '0'
          }
      END`,
    },
    [ORDER_BY_PSEUDO_FIELDS.CREATED_AT]: {
      query: `c."createdAt"`,
    },
    [ORDER_BY_PSEUDO_FIELDS.HOSTED_COLLECTIVES_COUNT]: {
      query: `
        SELECT COUNT(1) FROM "Collectives" hosted
        WHERE hosted."HostCollectiveId" = c.id
        AND hosted."deletedAt" IS NULL
        AND hosted."isActive" = TRUE
        AND hosted."type" IN ('COLLECTIVE', 'FUND')
      `,
    },
    [ORDER_BY_PSEUDO_FIELDS.HOST_RANK]: {
      query: `
        SELECT
          ARRAY [
            -- is host trusted or first party
            (
              CASE
                WHEN ((c.data#>'{isFirstPartyHost}')::boolean) THEN 3
                WHEN ((c.data#>'{isTrustedHost}')::boolean) THEN 2
                WHEN ((c.data#>'{isVerified}')::boolean) THEN 1
                ELSE 0
              END
            ),

            -- hosted collective count
            (SELECT COUNT(1) FROM "Collectives" hosted
            WHERE hosted."HostCollectiveId" = c.id
            AND hosted."deletedAt" IS NULL
            AND hosted."isActive" = TRUE
            AND hosted."type" IN ('COLLECTIVE', 'FUND'))
          ]`,
    },
    [ORDER_BY_PSEUDO_FIELDS.MONEY_MANAGED]: {
      query: `
        COALESCE((SELECT SUM(balance) FROM "CollectiveBalanceCheckpoint" WHERE "HostCollectiveId" = c.id AND "hostCurrency" = c."currency" GROUP BY "HostCollectiveId", "hostCurrency"), 0)
        * (SELECT rate FROM "CurrencyExchangeRates" WHERE "from" = c."currency" AND "to" = 'USD' ORDER BY "createdAt" DESC LIMIT 1)
      `,
    },
    [ORDER_BY_PSEUDO_FIELDS.BALANCE]: {
      query: CONSOLIDATED_BALANCE_SUBQUERY,
    },
  } as const;

  let sortQueryType = orderBy?.field || 'RANK';
  if (!searchTermConditions.sanitizedTerm && sortQueryType === 'RANK') {
    sortQueryType = 'CREATED_AT'; // We can't sort by rank if there's no search term, fallback on createdAt
  }

  if (!(sortQueryType in sortSubQueries)) {
    throw new Error(`Sort field ${sortQueryType} is not supported for this query`);
  } else {
    return {
      type: sortQueryType,
      query: sortSubQueries[sortQueryType].query,
      requiredJoin: sortSubQueries[sortQueryType].requiredJoin,
    };
  }
};

export type SearchCollectivesInDBOptions = {
  countries?: string[];
  currency?: string;
  hasCustomContributionsEnabled?: boolean;
  hostCollectiveIds?: number[];
  vendorVisibleToAccountIds?: number[];
  includeArchived?: boolean;
  includeVendorsForHostId?: number;
  includeAllVendors?: boolean;
  isHost?: boolean;
  onlyActive?: boolean;
  onlyOpenHosts?: boolean;
  orderBy?: { field?: string | ORDER_BY_PSEUDO_FIELDS; direction?: string };
  parentCollectiveIds?: number[];
  skipGuests?: boolean;
  skipRecentAccounts?: boolean;
  tags?: string[];
  tagSearchOperator?: 'AND' | 'OR';
  types?: string[];
  consolidatedBalance?: AmountRangeInputType;
  isRoot?: boolean;
  isPlatformSubscriber?: boolean;
  plan?: string[];
  isVerified?: boolean;
  isFirstPartyHost?: boolean;
  lastTransactionFrom?: Date;
  lastTransactionTo?: Date;
};

type BuildSearchCollectivesQueryResult = {
  pageSql: string;
  countSql: string;
  replacements: Record<string, unknown>;
  sortField: string;
};

/**
 * Builds the page and count SQL for `searchCollectivesInDB` without executing them.
 * Used by the search benchmark script to run EXPLAIN ANALYZE on production-shaped queries.
 */
export const buildSearchCollectivesQuery = async (
  req: express.Request,
  term: string,
  offset = 0,
  limit = 100,
  {
    countries,
    hasCustomContributionsEnabled,
    hostCollectiveIds,
    includeArchived,
    includeVendorsForHostId,
    includeAllVendors,
    vendorVisibleToAccountIds,
    isHost,
    onlyActive,
    orderBy,
    parentCollectiveIds,
    skipGuests = true,
    skipRecentAccounts,
    tags,
    tagSearchOperator,
    types,
    ...args
  }: SearchCollectivesInDBOptions = {},
): Promise<BuildSearchCollectivesQueryResult> => {
  const privateAccountVisibility = await buildPrivateAccountSearchVisibilitySQL(req);
  let dynamicConditions = privateAccountVisibility.sql;
  let countryCodes = null;
  let searchedTags = [''];
  if (countries) {
    countryCodes = `${countries.join(',')}`;
  }

  if (hostCollectiveIds && hostCollectiveIds.length > 0) {
    dynamicConditions += 'AND c."HostCollectiveId" IN (:hostCollectiveIds) ';
    dynamicConditions += 'AND c."approvedAt" IS NOT NULL ';
  }

  if (parentCollectiveIds && parentCollectiveIds.length > 0) {
    dynamicConditions += 'AND c."ParentCollectiveId" IN (:parentCollectiveIds) ';
  }

  if (isHost) {
    dynamicConditions += `AND c."hasMoneyManagement" IS TRUE AND c."type" = 'ORGANIZATION' `;
    if (args.onlyOpenHosts) {
      dynamicConditions += ` AND c."settings" #>> '{apply}' IS NOT NULL AND (c."settings" #>> '{apply}') != 'false'`;
    }
  }

  if (types?.length) {
    dynamicConditions += `AND c."type" IN (:types) `;
  }

  if (onlyActive) {
    dynamicConditions += 'AND c."isActive" = TRUE ';
  }

  if (!includeArchived) {
    dynamicConditions += 'AND c."deactivatedAt" IS NULL ';
  }

  if (includeVendorsForHostId) {
    dynamicConditions +=
      'AND (c."type" != \'VENDOR\' OR (c."type" = \'VENDOR\' AND c."ParentCollectiveId" = :includeVendorsForHostId)) ';
  } else if (!types && !includeAllVendors) {
    dynamicConditions += 'AND c."type" != \'VENDOR\' ';
  }

  if (!isNil(args.isPlatformSubscriber)) {
    dynamicConditions += `AND EXISTS (SELECT 1 FROM "PlatformSubscriptions" WHERE "CollectiveId" = c.id AND period @> NOW() AND "deletedAt" IS NULL) `;
  }

  if (!isUndefined(args.plan)) {
    if (args.plan?.includes('LEGACY')) {
      assert(args.plan.length === 1, new BadRequest('If plan includes LEGACY, it must be the only value'));
      dynamicConditions += `AND c."plan" IS NOT NULL `;
    } else {
      dynamicConditions += args.plan === null ? `AND c."plan" IS NULL` : `AND c."plan" IN (:plan) `;
    }
  }

  if (vendorVisibleToAccountIds) {
    dynamicConditions += `
      AND (
        c."type" != \'VENDOR\'
        OR data#>'{canBeUsedWithAccountIds}' IS NULL
        OR data#>'{canBeUsedWithAccountIds}' = '[]'::jsonb
        OR data#>'{canBeUsedWithAccountIds}' = 'null'::jsonb
        OR
          (
            jsonb_typeof(data#>'{canBeUsedWithAccountIds}')='array'
            AND
            EXISTS (
              SELECT v FROM (
                SELECT v::text::int FROM (SELECT jsonb_array_elements(data#>'{canBeUsedWithAccountIds}') as v)
              ) WHERE v IN (:vendorVisibleToAccountIds)
            )
          )
      )
    `;
  }

  if (skipRecentAccounts) {
    dynamicConditions += `AND (COALESCE((c."data"#>>'{spamReport,score}')::float, 0) <= 0.2 OR c."createdAt" < (NOW() - interval '2 day')) `;
  }

  if (skipGuests) {
    dynamicConditions += `AND (c."data" ->> 'isGuest')::boolean IS NOT TRUE `;
  }

  if (args.currency) {
    dynamicConditions += `AND (c."currency" = :currency)`;
  }

  if (typeof hasCustomContributionsEnabled === 'boolean') {
    if (hasCustomContributionsEnabled) {
      dynamicConditions += `AND (c."settings"->>'disableCustomContributions')::boolean IS NOT TRUE `;
    } else {
      dynamicConditions += `AND (c."settings"->>'disableCustomContributions')::boolean IS TRUE `;
    }
  }

  if (countryCodes) {
    dynamicConditions += `AND (c."countryISO" IN (:countryCodes) OR parentCollective."countryISO" IN (:countryCodes)) `;
  }

  if (tags?.length) {
    searchedTags = tags.map(tag => tag.toLowerCase());
    if (tagSearchOperator === 'OR') {
      dynamicConditions += `AND c."tags" && Array[:searchedTags]::varchar[] `;
    } else {
      dynamicConditions += `AND c."tags" @> Array[:searchedTags]::varchar[] `;
    }
  }

  const searchTermConditions = getSearchTermSQLConditions(term, 'c', args.isRoot);
  if (searchTermConditions.sqlConditions) {
    dynamicConditions += searchTermConditions.sqlConditions;
  }

  if (!isNil(args.isVerified) || !isNil(args.isFirstPartyHost)) {
    const verifiedConditions = [];
    if (!isNil(args.isVerified)) {
      verifiedConditions.push(`(c."data" ->> 'isVerified')::boolean IS ${args.isVerified ? 'TRUE' : 'FALSE'}`);
    }
    if (!isNil(args.isFirstPartyHost)) {
      verifiedConditions.push(
        `(c."data" ->> 'isFirstPartyHost')::boolean IS ${args.isFirstPartyHost ? 'TRUE' : 'FALSE'}`,
      );
    }
    if (verifiedConditions.length > 0) {
      dynamicConditions += `AND (${verifiedConditions.join(' OR ')}) `;
    }
  }
  if (args.lastTransactionFrom) {
    dynamicConditions += `AND transaction_stats."LatestTransactionCreatedAt" >= :lastTransactionFrom `;
  }
  if (args.lastTransactionTo) {
    dynamicConditions += `AND transaction_stats."LatestTransactionCreatedAt" <= :lastTransactionTo `;
  }

  // Small optimization: determine if we need to join the transaction stats table
  const sortSubQuery = getSortSubQuery(searchTermConditions, orderBy);
  const needsTransactionStatsJoin =
    sortSubQuery.requiredJoin === 'transaction_stats' || args.lastTransactionFrom || args.lastTransactionTo;

  const sortDirection = orderBy?.direction || 'DESC';
  const fromAndJoins = `
    FROM "Collectives" c
    ${countryCodes ? 'LEFT JOIN "Collectives" parentCollective ON c."ParentCollectiveId" = parentCollective.id' : ''}
    ${needsTransactionStatsJoin ? 'LEFT JOIN "CollectiveTransactionStats" transaction_stats ON transaction_stats."id" = c.id' : ''}`;

  const whereClause = `
    WHERE c."deletedAt" IS NULL
    AND (c."data" ->> 'hideFromSearch')::boolean IS NOT TRUE
    AND c.name NOT IN ('incognito', 'anonymous')
    AND c."isIncognito" = FALSE ${dynamicConditions}
    ${!isEmpty(args.consolidatedBalance) ? `AND ${CONSOLIDATED_BALANCE_SUBQUERY} ${getAmountRangeQuery(args.consolidatedBalance)}` : ''}`;

  const replacements = {
    types,
    term: term,
    slugifiedTerm: term ? slugify(term) : '',
    sanitizedTerm: searchTermConditions.sanitizedTerm,
    sanitizedTermNoWhitespaces: searchTermConditions.sanitizedTermNoWhitespaces,
    sanitizedTermForILike: searchTermConditions.sanitizedTermForILike,
    searchedTags,
    countryCodes,
    offset,
    limit,
    hostCollectiveIds,
    parentCollectiveIds,
    isHost,
    currency: args.currency,
    includeVendorsForHostId,
    plan: args.plan,
    lastTransactionFrom: args.lastTransactionFrom,
    lastTransactionTo: args.lastTransactionTo,
    vendorVisibleToAccountIds,
    privilegedCollectiveIds: privateAccountVisibility.privilegedCollectiveIds,
  };

  return {
    pageSql: `
    SELECT
      c.*,
      (${sortSubQuery.query}) as __sort__
    ${fromAndJoins}
    ${whereClause}
    ORDER BY __sort__ ${sortDirection}, c.id ${sortDirection}
    OFFSET :offset
    LIMIT :limit
    `,
    countSql: `
    SELECT COUNT(*)::int AS total
    ${fromAndJoins}
    ${whereClause}
    `,
    replacements,
    sortField: sortSubQuery.type,
  };
};

/**
 * Search collectives directly in the DB, using a full-text query.
 */
export const searchCollectivesInDB = async (
  req: express.Request,
  term: string,
  offset = 0,
  limit = 100,
  options: SearchCollectivesInDBOptions = {},
): Promise<[Collective[], number]> => {
  if (isEntityPublicId(term, EntityShortIdPrefix.Collective)) {
    const collective = await models.Collective.findOne({
      where: { publicId: term },
    });
    if (collective && (!collective.isPrivate || (await canSeePrivateAccount(req, collective)))) {
      return [[collective], 1];
    }
  }

  const { pageSql, countSql, replacements } = await buildSearchCollectivesQuery(req, term, offset, limit, options);

  const [result, countRows] = await Promise.all([
    sequelize.query(pageSql, {
      model: models.Collective,
      mapToModel: true,
      replacements,
    }),
    sequelize.query<{ total: number }>(countSql, {
      type: QueryTypes.SELECT,
      replacements,
      plain: true,
    }),
  ]);

  return [result, countRows.total];
};

/**
 * Parse and clean a user search query
 */
export const parseSearchTerm = (
  fullSearchTerm: string,
):
  | {
      type: 'email' | 'slug';
      term: string;
    }
  | {
      type: 'text';
      term: string | number;
      words?: number;
    }
  | {
      type: 'id';
      term: number;
    }
  | {
      type: 'number';
      term: number;
      isFloat?: boolean;
    }
  | {
      type: 'publicId';
      term: string;
      prefix: EntityShortIdPrefix;
    } => {
  const searchTerm = trimSearchTerm(fullSearchTerm);
  if (!searchTerm) {
    return { type: 'text', term: '' };
  }

  if (searchTerm.match(/^@.[^\s]+$/)) {
    // Searching for slugs (e.g. `@babel`). Won't match if there are whitespace chars (eg. `@babel expense from last month`)
    return { type: 'slug', term: searchTerm.replace(/^@/, '') };
  } else if (searchTerm.match(/^[\w\.]+@([\w-]+\.)+[\w-]{2,4}$/)) {
    return { type: 'email', term: searchTerm.toLowerCase() };
  } else if (searchTerm.match(/^#\d+$/)) {
    // Searching for integer IDs (e.g. `#123`)
    return { type: 'id', term: parseInt(searchTerm.replace(/^#/, '')) };
  } else if (searchTerm.match(/^\d+\.?\d*$/)) {
    return { type: 'number', term: parseFloat(searchTerm), isFloat: searchTerm.includes('.') };
  } else if (isAnyEntityPublicId(searchTerm)) {
    return { type: 'publicId', term: searchTerm, prefix: getEntityShortIdPrefix(searchTerm) };
  } else {
    // We use a custom pattern here because Lodash will split A123 to ['A', '123']
    const wordsCount = words(searchTerm, /[^, -]+/g).length;
    return { type: 'text', term: searchTerm, words: wordsCount };
  }
};

/**
 *
 * @param {string} searchTerm
 * @param {object} fieldsDefinition
 * @param {object} options
 *  - {string} stringArrayTransformFn: A function to transform values for array strings, usually uppercase/lowercase
 * @returns
 */
export const buildSearchConditions = (
  searchTerm: string,
  {
    slugFields = [],
    idFields = [],
    textFields = [],
    dataFields = [],
    amountFields = [],
    emailFields = [],
    stringArrayFields = [],
    stringArrayTransformFn = null,
    castStringArraysToVarchar = false,
    publicIdFields = [],
  }: {
    slugFields?: string[];
    idFields?: string[];
    textFields?: string[];
    dataFields?: string[];
    amountFields?: string[];
    emailFields?: string[];
    stringArrayFields?: string[];
    stringArrayTransformFn?: (str: string) => string;
    castStringArraysToVarchar?: boolean;
    publicIdFields?: {
      field: string | string[];
      prefix: EntityShortIdPrefix;
    }[];
  },
) => {
  const parsedTerm = parseSearchTerm(searchTerm);

  // Empty search => no condition
  if (!parsedTerm.term) {
    return [];
  }

  // Exclusive conditions: if an ID or a slug is searched, on don't search other attributes
  // We don't use ILIKE for them, they must match exactly
  if (parsedTerm.type === 'slug' && slugFields?.length) {
    return slugFields.map(field => ({ [field]: parsedTerm.term }));
  } else if (parsedTerm.type === 'id' && idFields?.length) {
    return idFields.map(field => ({ [field]: parsedTerm.term }));
  } else if (parsedTerm.type === 'email' && emailFields?.length) {
    return emailFields.map(field => ({ [field]: parsedTerm.term }));
  }

  // Inclusive conditions, search all fields except
  const conditions = [];

  if (parsedTerm.type === 'publicId' && publicIdFields?.length) {
    const fields = publicIdFields
      .filter(field => field.prefix === parsedTerm.prefix)
      .reduce((acc, field) => {
        if (Array.isArray(field.field)) {
          return [...acc, ...field.field];
        }
        return [...acc, field.field];
      }, []);

    conditions.push(...fields.map(field => ({ [field]: parsedTerm.term })));
  }
  // Conditions for text fields
  const strTerm = parsedTerm.term.toString(); // Some terms are returned as numbers
  const iLikeQuery = `%${sanitizeSearchTermForILike(strTerm)}%`;
  const allTextFields = [...(slugFields || []), ...(textFields || [])];
  allTextFields.forEach(field => conditions.push({ [field]: { [Op.iLike]: iLikeQuery } }));

  // Conditions for string array (usually tags lists)
  if (stringArrayFields?.length) {
    const preparedTerm = stringArrayTransformFn ? stringArrayTransformFn(strTerm) : strTerm;
    if (castStringArraysToVarchar) {
      stringArrayFields.forEach(field =>
        conditions.push({ [field]: { [Op.overlap]: sequelize.cast([preparedTerm], 'varchar[]') } }),
      );
    } else {
      stringArrayFields.forEach(field => conditions.push({ [field]: { [Op.overlap]: [preparedTerm] } }));
    }
  }

  if (
    dataFields?.length &&
    ((parsedTerm.type === 'text' && parsedTerm.words === 1) ||
      (parsedTerm.type === 'number' && !parsedTerm.isFloat) ||
      parsedTerm.type === 'publicId')
  ) {
    conditions.push(...dataFields.map(field => ({ [field]: toString(parsedTerm.term) })));
  }

  // Conditions for numbers (ID, amount)
  if (parsedTerm.type === 'number') {
    if (!parsedTerm.isFloat && idFields?.length) {
      conditions.push(...idFields.map(field => ({ [field]: parsedTerm.term })));
    }
    if (amountFields?.length) {
      conditions.push(...amountFields.map(field => ({ [field]: floatAmountToCents(parsedTerm.term as number) })));
    }
  }

  return conditions;
};

type KyselySearchField = string | Expression<unknown> | RawBuilder<unknown>;

export const buildKyselySearchConditions =
  <T>(
    searchTerm: string,
    {
      slugFields = [],
      idFields = [],
      textFields = [],
      dataFields = [],
      amountFields = [],
      emailFields = [],
      stringArrayFields = [],
      stringArrayTransformFn = null,
      castStringArraysToVarchar = false,
      publicIdFields = [],
    }: {
      slugFields?: KyselySearchField[];
      idFields?: KyselySearchField[];
      textFields?: KyselySearchField[];
      dataFields?: KyselySearchField[];
      amountFields?: KyselySearchField[];
      emailFields?: KyselySearchField[];
      stringArrayFields?: KyselySearchField[];
      stringArrayTransformFn?: (str: string) => string;
      castStringArraysToVarchar?: boolean;
      publicIdFields?: {
        field: KyselySearchField | KyselySearchField[];
        prefix: EntityShortIdPrefix;
      }[];
    },
  ) =>
  (q: SelectQueryBuilder<any, any, T>): SelectQueryBuilder<any, any, T> => {
    const parsedTerm = parseSearchTerm(searchTerm);

    // Empty search => no condition
    if (!parsedTerm.term) {
      return q;
    }

    // Exclusive conditions: if an ID, slug, or email is searched, don't search other attributes.
    if (parsedTerm.type === 'slug' && slugFields?.length) {
      return q.where(({ eb, or }) => or(slugFields.map(field => eb(field, '=', parsedTerm.term))));
    }
    if (parsedTerm.type === 'id' && idFields?.length) {
      return q.where(({ eb, or }) => or(idFields.map(field => eb(field, '=', parsedTerm.term))));
    }
    if (parsedTerm.type === 'email' && emailFields?.length) {
      return q.where(({ eb, or }) => or(emailFields.map(field => eb(field, '=', parsedTerm.term))));
    }
    if (parsedTerm.type === 'publicId' && publicIdFields?.length) {
      const fields = publicIdFields
        .filter(field => field.prefix === parsedTerm.prefix)
        .reduce<KyselySearchField[]>((acc, field) => {
          if (Array.isArray(field.field)) {
            return [...acc, ...field.field];
          }
          return [...acc, field.field];
        }, []);
      if (fields.length) {
        return q.where(({ eb, or }) => or(fields.map(field => eb(field, '=', parsedTerm.term))));
      }
    }

    // Inclusive conditions: single OR across all applicable field groups

    return q.where(({ eb, or }) => {
      const conditions = [];

      // Conditions for text fields
      const strTerm = parsedTerm.term.toString(); // Some terms are returned as numbers
      const allTextFields = [...(slugFields || []), ...(textFields || [])];

      // Partial match on slug + free-text columns (also used for multi-word queries).
      allTextFields.forEach(field => conditions.push(eb(field, 'ilike', `%${sanitizeSearchTermForILike(strTerm)}%`)));

      // Tag / string-array overlap
      if (stringArrayFields?.length) {
        const preparedTerm = stringArrayTransformFn ? stringArrayTransformFn(strTerm) : strTerm;
        stringArrayFields.forEach(field => {
          if (castStringArraysToVarchar) {
            conditions.push(eb(field, '&&', sql`CAST(ARRAY[${preparedTerm}] AS varchar[])`));
          } else {
            conditions.push(eb(field, '&&', sql`ARRAY[${preparedTerm}]::varchar[]`));
          }
        });
      }

      // Exact match on structured data columns (JSON paths, references): single token only,
      // so "foo bar" stays a text search and does not hit dataFields.
      if (
        dataFields?.length &&
        ((parsedTerm.type === 'text' && parsedTerm.words === 1) ||
          (parsedTerm.type === 'number' && !parsedTerm.isFloat))
      ) {
        dataFields.forEach(field => conditions.push(eb(field, '=', toString(parsedTerm.term))));
      }

      // Bare numbers (not #id): match integer id columns and/or amount columns (stored in cents).
      if (parsedTerm.type === 'number') {
        if (!parsedTerm.isFloat && idFields?.length) {
          idFields.forEach(field => conditions.push(eb(field, '=', parsedTerm.term)));
        }
        if (amountFields?.length) {
          amountFields.forEach(field => conditions.push(eb(field, '=', floatAmountToCents(parsedTerm.term as number))));
        }
      }

      // Same as buildSearchConditions returning []: skip search when no field applies.
      if (!conditions.length) {
        return eb.val(true);
      }

      return or(conditions);
    });
  };

/**
 * Returns tags along with their frequency of use.
 */
export const getColletiveTagFrequencies = async args => {
  // If no searchTerm is provided, we can use the pre-computed stats in the materialized view
  if (!args.searchTerm) {
    const { sanitizedTermForILike } = getSearchTermSQLConditions(args.tagSearchTerm);
    // Note: The CollectiveTagStats materialized view will return tag stats for all collectives, with or without host, when HostCollectiveId is NULL
    return sequelize.query(
      `SELECT tag AS id, tag, count
        FROM "CollectiveTagStats"
        WHERE "HostCollectiveId" ${args.hostCollectiveId ? '= :hostCollectiveId' : 'IS NULL'}
        ${args.tagSearchTerm ? `AND "tag" ILIKE :sanitizedTermForILike` : ``}
        ORDER BY count DESC
        LIMIT :limit
        OFFSET :offset`,
      {
        type: QueryTypes.SELECT,
        replacements: {
          sanitizedTermForILike: `%${sanitizedTermForILike}%`,
          hostCollectiveId: args.hostCollectiveId,
          limit: args.limit,
          offset: args.offset,
        },
      },
    );
  }
  const searchConditions = getSearchTermSQLConditions(args.searchTerm);
  return sequelize.query(
    `SELECT  UNNEST(tags) AS id, UNNEST(tags) AS tag, COUNT(id)
      FROM "Collectives"
      WHERE "deletedAt" IS NULL
      AND "deactivatedAt" IS NULL
      AND ((data ->> 'isGuest'::text)::boolean) IS NOT TRUE
      AND ((data ->> 'hideFromSearch'::text)::boolean) IS NOT TRUE
      AND name::text <> 'incognito'::text
      AND name::text <> 'anonymous'::text
      AND "isIncognito" = false
      ${args.hostCollectiveId ? `AND "HostCollectiveId" = :hostCollectiveId` : ``}
      ${searchConditions.sqlConditions}
      GROUP BY UNNEST(tags)
      ORDER BY count DESC
      LIMIT :limit
      OFFSET :offset`,
    {
      type: QueryTypes.SELECT,
      replacements: {
        sanitizedTerm: searchConditions.sanitizedTerm,
        sanitizedTermNoWhitespaces: searchConditions.sanitizedTermNoWhitespaces,
        hostCollectiveId: args.hostCollectiveId,
        limit: args.limit,
        offset: args.offset,
      },
    },
  );
};

/**
 * Returns expense tags along with their frequency of use.
 */
export const getExpenseTagFrequencies = async args => {
  const replacements = {
    limit: args.limit ?? 10,
    offset: args.offset ?? 0,
  };

  const whereConditions = [];

  if (args.hostCollectiveId) {
    whereConditions.push(`"HostCollectiveId" = :hostCollectiveId`);
    replacements['hostCollectiveId'] = args.hostCollectiveId;
  }

  if (args.accountId) {
    whereConditions.push(`"CollectiveId" = :accountId`);
    replacements['accountId'] = args.accountId;
  }

  if (args.tagSearchTerm) {
    const { sanitizedTermForILike } = getSearchTermSQLConditions(args.tagSearchTerm);
    whereConditions.push(`"tag" ILIKE :sanitizedTermForILike`);
    replacements['sanitizedTermForILike'] = `%${sanitizedTermForILike}%`;
  }

  const whereClause = whereConditions.length ? `WHERE ${whereConditions.join(' AND ')}` : '';

  return sequelize.query<{ id: string; tag: string; count: number }>(
    `SELECT tag AS id, tag, count
     FROM "ExpenseTagStats"
     ${whereClause}
     ORDER BY count DESC
     LIMIT :limit
     OFFSET :offset`,
    {
      type: QueryTypes.SELECT,
      replacements,
    },
  );
};
