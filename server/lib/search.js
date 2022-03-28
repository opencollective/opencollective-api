/**
 * Functions related to search
 */

import config from 'config';
import slugify from 'limax';
import { get } from 'lodash';

import { RateLimitExceeded } from '../graphql/errors';
import models, { Op, sequelize } from '../models';

import { floatAmountToCents } from './math';
import RateLimit, { ONE_HOUR_IN_SECONDS } from './rate-limit';

// Returned when there's no result for a search
const EMPTY_SEARCH_RESULT = [[], 0];

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
 * Turn a search string into a TS vector using 'OR' operator.
 *
 * Ex: "open potatoes" => "open|potatoes"
 */
const searchTermToTsVector = term => {
  return term.replace(/\s+/g, '|');
};

/**
 * Trim leading/trailing spaces and remove multiple spaces from the string
 */
const trimSearchTerm = term => {
  return term?.trim().replace(/\s+/g, ' ');
};

/**
 * Removes special ILIKE characters like `%
 */
const sanitizeSearchTermForILike = term => {
  return term.replace(/(_|%|\\)/g, '\\$1');
};

/**
 * Search collectives directly in the DB, using a full-text query.
 */
export const searchCollectivesInDB = async (
  term,
  offset = 0,
  limit = 100,
  {
    types,
    hostCollectiveIds,
    isHost,
    onlyActive,
    skipRecentAccounts,
    hasCustomContributionsEnabled,
    countries,
    tags,
  } = {},
) => {
  // Build dynamic conditions based on arguments
  let dynamicConditions = '';
  let isUsingTsVector = false;
  let countryCodes = null;
  if (countries) {
    countryCodes = `${countries.join(',')}`;
  }

  if (hostCollectiveIds && hostCollectiveIds.length > 0) {
    dynamicConditions += 'AND "HostCollectiveId" IN (:hostCollectiveIds) ';
  }

  if (isHost) {
    dynamicConditions += `AND "isHostAccount" IS TRUE AND "type" = 'ORGANIZATION' `;
  }

  if (types?.length) {
    dynamicConditions += `AND "type" IN (:types) `;
  }

  if (onlyActive) {
    dynamicConditions += 'AND "isActive" = TRUE ';
  }

  if (skipRecentAccounts) {
    dynamicConditions += `AND (COALESCE(("data"#>>'{spamReport,score}')::float, 0) <= 0.2 OR "createdAt" < (NOW() - interval '2 day')) `;
  }

  if (typeof hasCustomContributionsEnabled === 'boolean') {
    if (hasCustomContributionsEnabled) {
      dynamicConditions += `AND ("settings"->>'disableCustomContributions')::boolean IS NOT TRUE `;
    } else {
      dynamicConditions += `AND ("settings"->>'disableCustomContributions')::boolean IS TRUE `;
    }
  }

  if (countryCodes) {
    dynamicConditions += `AND "countryISO" IN (:countryCodes) `;
  }

  if (tags?.length) {
    tags.forEach(tag => {
      dynamicConditions += `AND '${tag}' = ANY("tags") `;
    });
  }

  // Cleanup term
  if (term && term.length > 0) {
    term = sanitizeSearchTermForILike(trimSearchTerm(term));
    if (term[0] === '@') {
      // When the search starts with a `@`, we search by slug only
      term = term.replace(/^@+/, '');
      dynamicConditions += `AND slug ILIKE '%' || :term || '%' `;
    } else {
      isUsingTsVector = true;
      dynamicConditions += `
        AND ("searchTsVector" @@ plainto_tsquery('english', :vectorizedTerm)
        OR "searchTsVector" @@ plainto_tsquery('simple', :vectorizedTerm))`;
    }
  } else {
    term = '';
  }

  // Build the query
  const result = await sequelize.query(
    `
    SELECT
      c.*,
      COUNT(*) OVER() AS __total__,
      (
        CASE WHEN (slug = :slugifiedTerm OR name ILIKE :term) THEN
          1
        ELSE
          ${isUsingTsVector ? `ts_rank("searchTsVector", plainto_tsquery('english', :vectorizedTerm))` : '0'}
        END
      ) AS __rank__
    FROM "Collectives" c
    WHERE "deletedAt" IS NULL
    AND "deactivatedAt" IS NULL
    AND ("data" ->> 'isGuest')::boolean IS NOT TRUE
    AND ("data" ->> 'hideFromSearch')::boolean IS NOT TRUE
    AND name != 'incognito'
    AND name != 'anonymous'
    AND "isIncognito" = FALSE ${dynamicConditions}
    ORDER BY __rank__ DESC
    OFFSET :offset
    LIMIT :limit
    `,
    {
      model: models.Collective,
      mapToModel: true,
      replacements: {
        types,
        term: term,
        slugifiedTerm: slugify(term),
        vectorizedTerm: searchTermToTsVector(term),
        countryCodes,
        offset,
        limit,
        hostCollectiveIds,
        isHost,
      },
    },
  );

  return [result, get(result[0], 'dataValues.__total__', 0)];
};

/**
 * Parse and clean a user search query
 */
export const parseSearchTerm = fullSearchTerm => {
  const searchTerm = trimSearchTerm(fullSearchTerm);
  if (!searchTerm) {
    return { type: 'text', term: '' };
  }

  if (searchTerm.match(/^@.[^\s]+$/)) {
    // Searching for slugs (e.g. `@babel`). Won't match if there are whitespace chars (eg. `@babel expense from last month`)
    return { type: 'slug', term: searchTerm.replace(/^@/, '') };
  } else if (searchTerm.match(/^#\d+$/)) {
    // Searching for integer IDs (e.g. `#123`)
    return { type: 'id', term: parseInt(searchTerm.replace(/^#/, '')) };
  } else if (searchTerm.match(/^\d+\.?\d*$/)) {
    return { type: 'number', term: parseFloat(searchTerm), isFloat: searchTerm.includes('.') };
  } else {
    return { type: 'text', term: searchTerm };
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
  searchTerm,
  {
    slugFields = [],
    idFields = [],
    textFields = [],
    amountFields = [],
    stringArrayFields = [],
    stringArrayTransformFn = null,
    castStringArraysToVarchar = false,
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

  // Conditions for numbers (ID, amount)
  if (parsedTerm.type === 'number') {
    if (!parsedTerm.isFloat && idFields?.length) {
      conditions.push(...idFields.map(field => ({ [field]: parsedTerm.term })));
    }
    if (amountFields?.length) {
      conditions.push(...amountFields.map(field => ({ [field]: floatAmountToCents(parsedTerm.term) })));
    }
  }

  return conditions;
};
