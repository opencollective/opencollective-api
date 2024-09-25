/**
 * Functions related to search
 */

import config from 'config';
import slugify from 'limax';
import { get, isEmpty, toString, words } from 'lodash';
import { Model, ModelStatic, Order } from 'sequelize';
import isEmail from 'validator/lib/isEmail';

import { RateLimitExceeded } from '../graphql/errors';
import { ORDER_BY_PSEUDO_FIELDS } from '../graphql/v2/enum/OrderByFieldType';
import {
  AmountRangeInputType,
  getAmountRangeQuery,
  makeConsolidatedBalanceSubquery,
} from '../graphql/v2/input/AmountRangeInput';
import models, { Op, sequelize } from '../models';

import { floatAmountToCents } from './math';
import RateLimit, { ONE_HOUR_IN_SECONDS } from './rate-limit';
import { runPromiseOrTimeout } from './utils';

// Returned when there's no result for a search
const EMPTY_SEARCH_RESULT = [[], 0];

const CONSOLIDATED_BALANCE_SUBQUERY = makeConsolidatedBalanceSubquery('c');

/**
 * Search users by email address. `user` must be set because this endpoint is rate
 * limited to prevent abuse.
 *
 * @param {String} email - a valid email address
 * @param {Object} user - the user triggering the search
 */
export const searchCollectivesByEmail = async (email, user, offset = 0, limit = 10) => {
  if (!email || !user) {
    return EMPTY_SEARCH_RESULT;
  }

  // Put some rate limiting to users can't use this endpoint to bruteforce emails
  const rateLimit = new RateLimit(
    `user_email_search_${user.id}`,
    config.limits.searchEmailPerHour,
    ONE_HOUR_IN_SECONDS,
  );

  if (!(await rateLimit.registerCall())) {
    throw new RateLimitExceeded();
  }

  // Emails are uniques, thus there should never be more than one result - this is
  // why it's safe to use `collectives.length` in the return.
  const collectives = await sequelize.query(
    `
    SELECT  c.*, COUNT(*) OVER() AS __total__
    FROM "Collectives" c
    INNER JOIN "Users" u ON u."CollectiveId" = c.id
    WHERE c."isIncognito" = FALSE AND c.type = 'USER' AND u.email = :email
    OFFSET :offset
    LIMIT :limit
    `,
    {
      model: models.Collective,
      mapToModel: true,
      replacements: { offset, limit, email },
    },
  );

  return [collectives, get(collectives[0], 'dataValues.__total__', 0)];
};

/**
 * Trim leading/trailing spaces and remove multiple spaces from the string
 */
const trimSearchTerm = term => {
  return term?.trim().replace(/\s+/g, ' ');
};

/**
 * Example: "crème brulée => "creme brulee"
 */
const removeDiacritics = str => {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
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
const sanitizeSearchTermForILike = term => {
  return term.replace(/(_|%|\\)/g, '\\$1');
};

const getSearchTermSQLConditions = (term: string, collectiveTable?: string, isRoot = false) => {
  let tsQueryFunc, tsQueryArg;
  let sqlConditions = '';
  let sanitizedTerm = '';
  let sanitizedTermNoWhitespaces = '';
  const trimmedTerm = trimSearchTerm(term);
  const getField = field => (collectiveTable ? `${collectiveTable}."${field}"` : `"${field}"`);
  if (trimmedTerm?.length > 0) {
    // Cleanup term
    const splitTerm = trimmedTerm.split(' ');
    if (term[0] === '@' && splitTerm.length === 1) {
      // When the search starts with a `@`, we search by slug only
      sanitizedTerm = sanitizeSearchTermForILike(removeDiacritics(trimmedTerm).replace(/^@+/, ''));
      sqlConditions = `AND ${getField('slug')} ILIKE :sanitizedTerm || '%' `;
    } else if (isRoot && splitTerm.length === 1 && isEmail(trimmedTerm)) {
      sanitizedTerm = trimmedTerm.toLowerCase();
      sqlConditions = `AND EXISTS (SELECT id FROM "Users" WHERE "deletedAt" IS NULL AND email = :sanitizedTerm AND "CollectiveId" = ${getField('id')})`;
    } else {
      sanitizedTerm = splitTerm.length === 1 ? sanitizeSearchTermForTSQuery(trimmedTerm) : trimmedTerm;
      sanitizedTermNoWhitespaces = sanitizedTerm.replace(/\s/g, '');
      // Only search for existing term
      if (sanitizedTerm) {
        if (splitTerm.length === 1) {
          tsQueryFunc = 'to_tsquery';
          tsQueryArg = `concat(:sanitizedTerm, ':*')`;
          sqlConditions = `
          AND (${getField('searchTsVector')} @@ to_tsquery('english', concat(:sanitizedTerm, ':*'))
          OR ${getField('searchTsVector')} @@ to_tsquery('simple', concat(:sanitizedTerm, ':*')))`;
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

  return { sqlConditions, tsQueryArg, tsQueryFunc, sanitizedTerm, sanitizedTermNoWhitespaces };
};

const getSortSubQuery = (
  searchTermConditions,
  orderBy: { field?: string | ORDER_BY_PSEUDO_FIELDS; direction?: string } = null,
) => {
  const sortSubQueries = {
    [ORDER_BY_PSEUDO_FIELDS.ACTIVITY]: `COALESCE(transaction_stats."count", 0)`,
    [ORDER_BY_PSEUDO_FIELDS.RANK]: `
      CASE WHEN (c."slug" = :slugifiedTerm OR c."name" ILIKE :sanitizedTerm) THEN
        1
      ELSE
        ${
          searchTermConditions.tsQueryFunc
            ? `ts_rank(c."searchTsVector", ${searchTermConditions.tsQueryFunc}('english', ${searchTermConditions.tsQueryArg}), 1)`
            : '0'
        }
      END`,
    [ORDER_BY_PSEUDO_FIELDS.CREATED_AT]: `c."createdAt"`,
    [ORDER_BY_PSEUDO_FIELDS.HOSTED_COLLECTIVES_COUNT]: `
      SELECT COUNT(1) FROM "Collectives" hosted
      WHERE hosted."HostCollectiveId" = c.id
      AND hosted."deletedAt" IS NULL
      AND hosted."isActive" = TRUE
      AND hosted."type" IN ('COLLECTIVE', 'FUND')
    `,
    [ORDER_BY_PSEUDO_FIELDS.HOST_RANK]: `
        SELECT
          ARRAY [
            -- is host trusted or first party
            (
              CASE
                WHEN ((c.data#>'{isFirstPartyHost}')::boolean) THEN 2
                WHEN ((c.data#>'{isTrustedHost}')::boolean) THEN 1
                ELSE 0
              END
            ),

            -- hosted collective count
            (SELECT COUNT(1) FROM "Collectives" hosted
            WHERE hosted."HostCollectiveId" = c.id
            AND hosted."deletedAt" IS NULL
            AND hosted."isActive" = TRUE
            AND hosted."type" IN ('COLLECTIVE', 'FUND'))
          ]
    `,
    [ORDER_BY_PSEUDO_FIELDS.BALANCE]: CONSOLIDATED_BALANCE_SUBQUERY,
  };

  let sortQueryType = orderBy?.field || 'RANK';
  if (!searchTermConditions.sanitizedTerm && sortQueryType === 'RANK') {
    sortQueryType = 'CREATED_AT'; // We can't sort by rank if there's no search term, fallback on createdAt
  }

  if (!(sortQueryType in sortSubQueries)) {
    throw new Error(`Sort field ${sortQueryType} is not supported for this query`);
  } else {
    return sortSubQueries[sortQueryType];
  }
};

/**
 * Search collectives directly in the DB, using a full-text query.
 */
export const searchCollectivesInDB = async (
  term: string,
  offset = 0,
  limit = 100,
  {
    countries,
    hasCustomContributionsEnabled,
    hostCollectiveIds,
    includeArchived,
    includeVendorsForHostId,
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
  }: {
    countries?: string[];
    currency?: string;
    hasCustomContributionsEnabled?: boolean;
    hostCollectiveIds?: number[];
    includeArchived?: boolean;
    includeVendorsForHostId?: number;
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
  } = {},
) => {
  // Build dynamic conditions based on arguments
  let dynamicConditions = '';
  let countryCodes = null;
  let searchedTags = '';
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
    dynamicConditions += `AND c."isHostAccount" IS TRUE AND c."type" = 'ORGANIZATION' `;
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
  } else if (!types) {
    dynamicConditions += 'AND c."type" != \'VENDOR\' ';
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
    searchedTags = tags.map(tag => tag.toLowerCase()).join();
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

  // Build the query
  const result = await sequelize.query(
    `
    SELECT
      c.*,
      COUNT(*) OVER() AS __total__,
      (${getSortSubQuery(searchTermConditions, orderBy)}) as __sort__
    FROM "Collectives" c
    ${countryCodes ? 'LEFT JOIN "Collectives" parentCollective ON c."ParentCollectiveId" = parentCollective.id' : ''}
    LEFT JOIN "CollectiveTransactionStats" transaction_stats ON transaction_stats."id" = c.id
    WHERE c."deletedAt" IS NULL
    AND (c."data" ->> 'hideFromSearch')::boolean IS NOT TRUE
    AND c.name != 'incognito'
    AND c.name != 'anonymous'
    AND c."isIncognito" = FALSE ${dynamicConditions}
    ${!isEmpty(args.consolidatedBalance) ? `AND ${CONSOLIDATED_BALANCE_SUBQUERY} ${getAmountRangeQuery(args.consolidatedBalance)}` : ''}
    ORDER BY __sort__ ${orderBy?.direction || 'DESC'}
    OFFSET :offset
    LIMIT :limit
    `,
    {
      model: models.Collective,
      mapToModel: true,
      replacements: {
        types,
        term: term,
        slugifiedTerm: term ? slugify(term) : '',
        sanitizedTerm: searchTermConditions.sanitizedTerm,
        sanitizedTermNoWhitespaces: searchTermConditions.sanitizedTermNoWhitespaces,
        searchedTags,
        countryCodes,
        offset,
        limit,
        hostCollectiveIds,
        parentCollectiveIds,
        isHost,
        currency: args.currency,
        includeVendorsForHostId,
      },
    },
  );

  return [result, get(result[0], 'dataValues.__total__', 0)];
};

/**
 * Parse and clean a user search query
 */
export const parseSearchTerm = (
  fullSearchTerm: string,
): {
  type: 'text' | 'slug' | 'email' | 'id' | 'number' | 'text';
  term: string | number;
  isFloat?: boolean;
  words?: number;
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

  if (dataFields?.length && (parsedTerm.words === 1 || (parsedTerm.type === 'number' && !parsedTerm.isFloat))) {
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

/**
 * Returns tags along with their frequency of use.
 */
export const getColletiveTagFrequencies = async args => {
  // If no searchTerm is provided, we can use the pre-computed stats in the materialized view
  if (!args.searchTerm) {
    const { sanitizedTerm } = getSearchTermSQLConditions(args.tagSearchTerm);
    // Note: The CollectiveTagStats materialized view will return tag stats for all collectives, with or without host, when HostCollectiveId is NULL
    return sequelize.query(
      `SELECT tag AS id, tag, count
        FROM "CollectiveTagStats"
        WHERE "HostCollectiveId" ${args.hostCollectiveId ? '= :hostCollectiveId' : 'IS NULL'} 
        ${args.tagSearchTerm ? `AND "tag" ILIKE :sanitizedTerm` : ``}
        ORDER BY count DESC
        LIMIT :limit
        OFFSET :offset`,
      {
        type: sequelize.QueryTypes.SELECT,
        replacements: {
          sanitizedTerm: `%${sanitizedTerm}%`,
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
      type: sequelize.QueryTypes.SELECT,
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
    const { sanitizedTerm } = getSearchTermSQLConditions(args.tagSearchTerm);
    whereConditions.push(`"tag" ILIKE :sanitizedTerm`);
    replacements['sanitizedTerm'] = `%${sanitizedTerm}%`;
  }

  const whereClause = whereConditions.length ? `WHERE ${whereConditions.join(' AND ')}` : '';

  return sequelize.query(
    `SELECT tag AS id, tag, count
     FROM "ExpenseTagStats"
     ${whereClause}
     ORDER BY count DESC
     LIMIT :limit
     OFFSET :offset`,
    {
      type: sequelize.QueryTypes.SELECT,
      replacements,
    },
  );
};

const getSQLSearchConditionsForModel = (
  model: ModelStatic<Model>,
  searchTerm: string,
  adminOfAccountIds: number[],
  host?: InstanceType<typeof models.Collective>,
  account?: InstanceType<typeof models.Collective>,
) => {
  if (model instanceof models.Collective) {
    return {
      where: {
        ...(host && { HostCollectiveId: host.id }),
        ...(account && { [Op.or]: [{ id: account.id }, { ParentCollectiveId: account.id }] }),
        [Op.or]: buildSearchConditions(searchTerm, {
          idFields: ['id'],
          textFields: ['name', 'description', 'longDescription', 'website'],
          slugFields: ['slug'],
          stringArrayFields: ['tags'],
        }),
      },
    };
  } else if (model instanceof models.Comment) {
    return {
      where: {
        [Op.or]: buildSearchConditions(searchTerm, {
          idFields: ['id'],
          textFields: ['html'],
        }),
      },
      include: [
        {
          association: 'collective',
          attributes: [],
          required: true,
          where: {
            // Can only search comments of collectives the user is admin of
            ...(host && { HostCollectiveId: host.id }),
            ...(account && { [Op.or]: [{ id: account.id }, { ParentCollectiveId: account.id }] }),
            [Op.or]: [
              { id: adminOfAccountIds },
              { ParentCollectiveId: adminOfAccountIds },
              { HostCollectiveId: adminOfAccountIds, isActive: true },
            ],
          },
        },
      ],
    };
  } else if (model instanceof models.Expense) {
    return {
      include: [
        { association: 'User', attributes: [], include: [{ association: 'collective', attributes: [] }] },
        { association: 'fromCollective', attributes: [] },
        {
          association: 'collective',
          attributes: [],
          required: true,
          where: {
            ...(host && { HostCollectiveId: host.id }),
            ...(account && { [Op.or]: [{ id: account.id }, { ParentCollectiveId: account.id }] }),
          },
        },
      ],
      where: {
        [Op.or]: buildSearchConditions(searchTerm, {
          idFields: ['id'],
          slugFields: ['$fromCollective.slug$', '$collective.slug$', '$User.collective.slug$'],
          textFields: ['$fromCollective.name$', '$collective.name$', '$User.collective.name$', 'description'],
          amountFields: ['amount'],
          stringArrayFields: ['tags'],
          stringArrayTransformFn: (str: string) => str.toLowerCase(), // expense tags are stored lowercase
        }),
      },
    };
  } else if (model instanceof models.HostApplication) {
    return {
      include: [{ association: 'collective', attributes: [], required: true }],
      where: {
        ...(host && { HostCollectiveId: host.id }),
        ...(account && { [Op.or]: [{ id: account.id }, { ParentCollectiveId: account.id }] }),
        [Op.and]: [
          {
            [Op.or]: [{ HostCollectiveId: adminOfAccountIds }, { CollectiveId: adminOfAccountIds }],
          },
          {
            [Op.or]: buildSearchConditions(searchTerm, {
              slugFields: ['$collective.slug$'],
              textFields: ['message', '$collective.name$'],
              idFields: ['id'],
            }),
          },
        ],
      },
    };
  } else if (model instanceof models.Order) {
    return {
      include: [
        { model: models.Collective, as: 'fromCollective', attributes: [], required: true },
        {
          model: models.Collective,
          as: 'collective',
          attributes: [],
          required: true,
          where: {
            ...(host && { HostCollectiveId: host.id }),
            ...(account && { [Op.or]: [{ id: account.id }, { ParentCollectiveId: account.id }] }),
          },
        },
      ],
      where: {
        [Op.or]: buildSearchConditions(searchTerm, {
          textFields: ['description', '$fromCollective.name$', '$collective.name$'],
          idFields: ['id'],
        }),
      },
    };
  } else if (model instanceof models.Tier) {
    return {
      include: [
        {
          model: models.Collective,
          attributes: [],
          required: true,
          where: {
            ...(host && { HostCollectiveId: host.id }),
            ...(account && { [Op.or]: [{ id: account.id }, { ParentCollectiveId: account.id }] }),
          },
        },
      ],
      where: {
        [Op.or]: buildSearchConditions(searchTerm, {
          textFields: ['name', 'description'],
          idFields: ['id'],
          slugFields: ['slug'],
        }),
      },
    };
  } else if (model instanceof models.Transaction) {
    return {
      include: [
        { model: models.Collective, as: 'fromCollective', attributes: [], required: true },
        {
          model: models.Collective,
          as: 'collective',
          attributes: [],
          required: true,
          where: {
            ...(account && { [Op.or]: [{ id: account.id }, { ParentCollectiveId: account.id }] }),
          },
        },
      ],
      where: {
        ...(host && { HostCollectiveId: host.id }),
        [Op.or]: buildSearchConditions(searchTerm, {
          idFields: ['id', 'ExpenseId', 'OrderId'],
          slugFields: ['$fromCollective.slug$', '$collective.slug$'],
          textFields: ['$fromCollective.name$', '$collective.name$', 'description'],
          amountFields: ['amount'],
        }),
      },
    };
  } else if (model instanceof models.Update) {
    return {
      include: [
        {
          model: models.Collective,
          as: 'collective',
          attributes: [],
          required: true,
          where: {
            ...(host && { HostCollectiveId: host.id }),
            ...(account && { [Op.or]: [{ id: account.id }, { ParentCollectiveId: account.id }] }),
          },
        },
      ],
      where: {
        [Op.and]: [
          {
            [Op.or]: buildSearchConditions(searchTerm, {
              idFields: ['id'],
              textFields: ['html', 'title'],
            }),
          },
          {
            [Op.or]: [{ isPrivate: false }, { CollectiveId: adminOfAccountIds }],
          },
        ],
      },
    };
  } else {
    throw new Error(`Unsupported SQL search for model: ${model.name}`);
  }
};

export const getSQLSearchResolver = (
  model: ModelStatic<Model>,
  {
    limit,
    host,
    account,
    searchTerm,
    timeout,
    adminOfAccountIds,
  }: {
    limit: number;
    host?: InstanceType<typeof models.Collective>;
    account?: InstanceType<typeof models.Collective>;
    searchTerm: string;
    timeout: number;
    adminOfAccountIds: number[];
  },
) => {
  const timeoutMessage = 'Field resolution timed out';
  const query = getSQLSearchConditionsForModel(model, searchTerm, adminOfAccountIds, host, account);
  const order = [['id', 'ASC']] as Order;
  return {
    collection: {
      nodes: () => runPromiseOrTimeout(model.findAll({ ...query, limit, order }), timeout, timeoutMessage),
      totalCount: () => runPromiseOrTimeout(model.count(query), timeout, timeoutMessage),
      offset: 0,
      limit: limit,
    },
  };
};
