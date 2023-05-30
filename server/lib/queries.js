import config from 'config';
import { get, pick } from 'lodash';

import {
  TAX_FORM_IGNORED_EXPENSE_STATUSES,
  TAX_FORM_IGNORED_EXPENSE_TYPES,
  US_TAX_FORM_VALIDITY_IN_YEARS,
} from '../constants/tax-form';
import { PayoutMethodTypes } from '../models/PayoutMethod';

import { memoize } from './cache';
import { convertToCurrency } from './currency';
import sequelize, { Op } from './sequelize';
import { amountsRequireTaxForm } from './tax-forms';
import { ifStr } from './utils';

const twoHoursInSeconds = 2 * 60 * 60;
const models = sequelize.models;

/*
 * Hacky way to do currency conversion
 */
const generateFXConversionSQL = async aggregate => {
  let currencyColumn = 't.currency';
  let amountColumn = 't."netAmountInCollectiveCurrency"';

  if (aggregate) {
    currencyColumn = 'MAX(t.currency)';
    amountColumn = 'SUM("t."netAmountInCollectiveCurrency"")';
  }

  const currencies = ['AUD', 'CAD', 'EUR', 'GBP', 'INR', 'MXN', 'SEK', 'USD', 'UYU'];

  const result = await Promise.all(
    currencies.map(async currency => {
      const amount = await convertToCurrency(1, 'USD', currency);
      return `WHEN ${currencyColumn} = '${currency}' THEN ${amountColumn} / ${amount}`;
    }),
  );

  return `CASE ${result.join('\n')}ELSE 0 END`;
};

const getHosts = async args => {
  let hostConditions = '';
  if (args.tags && args.tags.length > 0) {
    hostConditions = 'AND hosts.tags && $tags';
  }
  if (args.currency && args.currency.length === 3) {
    hostConditions += ' AND hosts.currency=$currency';
  }
  if (args.onlyOpenHosts) {
    hostConditions += ` AND hosts."settings" #>> '{apply}' IS NOT NULL AND (hosts."settings" #>> '{apply}') != 'false'`;
  }

  const query = `
    WITH all_hosts AS (
      SELECT hosts.id as "HostCollectiveId", count(c.id) as count
      FROM "Collectives" hosts
      LEFT JOIN "Members" m
        ON m."MemberCollectiveId" = hosts.id
        AND m.role = 'HOST'
        AND m."deletedAt" IS NULL
      LEFT JOIN "Collectives" c
        ON c.id = m."CollectiveId"
        AND c."deletedAt" IS NULL
        AND c."isActive" = TRUE
        AND c."type" IN ('COLLECTIVE', 'FUND')
      WHERE hosts."deletedAt" IS NULL AND hosts."isHostAccount" = TRUE ${hostConditions}
      GROUP BY hosts.id
      HAVING count(c.id) >= $minNbCollectivesHosted
    ) SELECT c.*, (SELECT COUNT(*) FROM all_hosts) AS __hosts_count__, SUM(all_hosts.count) as __members_count__
    FROM "Collectives" c INNER JOIN all_hosts ON all_hosts."HostCollectiveId" = c.id
    GROUP BY c.id
    ORDER BY
      ${args.orderBy === 'collectives' ? '__members_count__' : args.orderBy} ${args.orderDirection},
      id ASC
    LIMIT $limit
    OFFSET $offset
  `;

  const result = await sequelize.query(query, {
    bind: {
      tags: args.tags || [],
      currency: args.currency,
      limit: args.limit,
      offset: args.offset,
      minNbCollectivesHosted: args.minNbCollectivesHosted,
    },
    type: sequelize.QueryTypes.SELECT,
    model: models.Collective,
    mapToModel: true,
  });

  return { collectives: result, total: get(result[0], 'dataValues.__hosts_count__', 0) };
};

const getTotalAnnualBudgetForHost = HostCollectiveId => {
  return sequelize
    .query(
      `
  WITH
    "collectiveids" AS (
      SELECT id FROM "Collectives"
      WHERE "HostCollectiveId" = :HostCollectiveId
      AND "isActive"=true
      AND "deletedAt" IS NULL
    ),
    "monthlyOrdersWithAmountInHostCurrency" AS (
      SELECT o.id, MAX(o."CollectiveId") as "CollectiveId", MAX(t.currency) AS currency, MAX(t."amountInHostCurrency") as "amountInHostCurrency"
      FROM "Orders" o
      LEFT JOIN "Subscriptions" s ON o."SubscriptionId" = s.id
      LEFT JOIN "Transactions" t ON t."OrderId" = o.id
      WHERE s.interval = 'month' AND s."isActive" = true
        AND o."CollectiveId" IN (SELECT id FROM collectiveids)
        AND o."deletedAt" IS NULL
        AND s."deletedAt" IS NULL
        AND t."deletedAt" IS NULL
      GROUP BY o.id
    ),
    "yearlyAndOneTimeOrdersWithAmountInHostCurrency" AS (
      SELECT o.id, MAX(o."CollectiveId") as "CollectiveId", MAX(t.currency) AS currency, MAX(t."amountInHostCurrency") as "amountInHostCurrency"
      FROM "Orders" o
      LEFT JOIN "Subscriptions" s ON o."SubscriptionId" = s.id
      LEFT JOIN "Transactions" t ON t."OrderId" = o.id
      WHERE ((s.interval = 'year' AND s."isActive" = true) OR s.interval IS NULL)
        AND o."CollectiveId" IN (SELECT id FROM collectiveids)
        AND o."deletedAt" IS NULL
        AND s."deletedAt" IS NULL
        AND t."createdAt" > (current_date - INTERVAL '12 months')
        AND t."deletedAt" IS NULL
      GROUP BY o.id
    )

  SELECT
    ( SELECT COALESCE(SUM("amountInHostCurrency") * 12, 0) FROM "monthlyOrdersWithAmountInHostCurrency" t )
    +
    ( SELECT COALESCE(SUM("amountInHostCurrency"), 0) FROM "yearlyAndOneTimeOrdersWithAmountInHostCurrency" t )
    +
    (SELECT
      COALESCE(SUM("amountInHostCurrency"),0) FROM "Transactions" t
      LEFT JOIN "Orders" o on t."OrderId" = o.id
      LEFT JOIN "Subscriptions" s ON o."SubscriptionId" = s.id
      WHERE t.type='CREDIT' AND t."CollectiveId" IN (SELECT id FROM collectiveids)
        AND t."deletedAt" IS NULL
        AND t."createdAt" > (current_date - INTERVAL '12 months')
        AND s.interval = 'month' AND s."isActive" IS FALSE AND s."deletedAt" IS NULL
        AND t."deletedAt" IS NULL
        AND o."deletedAt" IS NULL
    )
    "yearlyIncome"
  `,
      {
        replacements: { HostCollectiveId },
        type: sequelize.QueryTypes.SELECT,
      },
    )
    .then(res => Math.round(parseInt(res[0].yearlyIncome, 10)));
};

const getTotalAnnualBudget = async () => {
  const fxConversionSQL = await generateFXConversionSQL();

  return sequelize
    .query(
      `
  SELECT
    (SELECT
      COALESCE(SUM(${fxConversionSQL} * 12),0)
      FROM "Subscriptions" s
      LEFT JOIN "Orders" d ON s.id = d."SubscriptionId"
      LEFT JOIN "Transactions" t
      ON (s.id = d."SubscriptionId"
        AND t.id = (SELECT MAX(id) from "Transactions" t where t."OrderId" = d.id))
      WHERE t.type='CREDIT' AND t."CollectiveId" != 1
        AND t."deletedAt" IS NULL
        AND s.interval = 'month'
        AND s."isActive" IS TRUE
        AND s."deletedAt" IS NULL)
    +
    (SELECT
      COALESCE(SUM(${fxConversionSQL}),0) FROM "Transactions" t
      LEFT JOIN "Orders" d ON t."OrderId" = d.id
      LEFT JOIN "Subscriptions" s ON d."SubscriptionId" = s.id
      WHERE t.type='CREDIT' AND t."CollectiveId" != 1
        AND t."deletedAt" IS NULL
        AND t."createdAt" > (current_date - INTERVAL '12 months')
        AND ((s.interval = 'year' AND s."isActive" IS TRUE AND s."deletedAt" IS NULL) OR s.interval IS NULL))
    +
    (SELECT
      COALESCE(SUM(${fxConversionSQL}),0) FROM "Transactions" t
      LEFT JOIN "Orders" d on t."OrderId" = d.id
      LEFT JOIN "Subscriptions" s ON d."SubscriptionId" = s.id
      WHERE t.type='CREDIT' AND t."CollectiveId" != 1
        AND t."deletedAt" IS NULL
        AND t."createdAt" > (current_date - INTERVAL '12 months')
        AND s.interval = 'month' AND s."isActive" IS FALSE AND s."deletedAt" IS NULL)
    "yearlyIncome"
  `,
      {
        type: sequelize.QueryTypes.SELECT,
      },
    )
    .then(res => Math.round(parseInt(res[0].yearlyIncome, 10)));
};

/**
 * Returns the top backers (Collectives) in a given time range in given tags
 * E.g. top backers in open source collectives last June
 */
const getTopBackers = (since, until, tags, limit) => {
  const sinceClause = since ? `AND t."createdAt" >= '${since.toISOString()}'` : '';
  const untilClause = until ? `AND t."createdAt" < '${until.toISOString()}'` : '';
  const tagsClause = tags ? 'AND collective.tags && $tags' : ''; // && operator means "overlaps"

  return sequelize.query(
    `
    SELECT
      MAX(fromCollective.id) as id,
      MAX(fromCollective.slug) as slug,
      MAX(fromCollective.name) as name,
      MAX(fromCollective.website) as "website",
      MAX(fromCollective."twitterHandle") as "twitterHandle",
      MAX(fromCollective.image) as "image",
      SUM("amount") as "totalDonations",
      MAX(t.currency) as "currency"
    FROM "Transactions" t
    LEFT JOIN "Collectives" fromCollective ON fromCollective.id = t."FromCollectiveId"
    LEFT JOIN "Collectives" collective ON collective.id = t."CollectiveId"
    WHERE
      t.type='CREDIT'
      AND t."deletedAt" IS NULL
      ${sinceClause}
      ${untilClause}
      ${tagsClause}
    GROUP BY "FromCollectiveId"
    ORDER BY "totalDonations" DESC
    LIMIT ${limit}
    `.replace(/\s\s+/g, ' '), // this is to remove the new lines and save log space.
    {
      bind: { tags: tags || [] },
      model: models.Collective,
    },
  );
};

/**
 * Get top collectives ordered by available balance
 */
const getCollectivesWithBalance = async (where = {}, options) => {
  const orderDirection = options.orderDirection || 'DESC';
  const orderBy = options.orderBy || 'balance';
  const limit = options.limit || 20;
  const offset = options.offset || 0;

  let whereCondition = '';
  Object.keys(where).forEach(key => {
    if (key === 'tags') {
      whereCondition += 'AND c.tags && $tags '; // && operator means "overlaps", e.g. ARRAY[1,4,3] && ARRAY[2,1] == true
      where.tags = where.tags[Op.overlap];
    } else {
      whereCondition += `AND c."${key}"=$${key} `;
    }
  });

  const params = {
    bind: where,
    model: models.Collective,
  };

  const allFields = 'c.*, td.*';

  /* This version doesn't include limit/offset */
  const sql = fields =>
    `
    with "balance" AS (
      SELECT t."CollectiveId", SUM("netAmountInCollectiveCurrency") as "balance"
      FROM "Collectives" c
      LEFT JOIN "Transactions" t ON t."CollectiveId" = c.id
      WHERE
        c.type = 'COLLECTIVE'
        AND t."deletedAt" IS NULL
        AND c."isActive" IS TRUE
        ${whereCondition}
        AND c."deletedAt" IS NULL
        GROUP BY t."CollectiveId"
    )
    SELECT ${fields} FROM "Collectives" c
    LEFT JOIN "balance" td ON td."CollectiveId" = c.id
    WHERE c."isActive" IS TRUE
    ${whereCondition}
    AND c."deletedAt" IS NULL
    GROUP BY c.id, td."CollectiveId", td.balance
    ORDER BY ${orderBy} ${orderDirection} NULLS LAST
  `.replace(/\s\s+/g, ' '); // remove the new lines and save log space

  const [[totalResult], collectives] = await Promise.all([
    sequelize.query(`${sql('COUNT(c.*) OVER() as "total"')} LIMIT 1`, params),
    sequelize.query(`${sql(allFields)} LIMIT ${limit} OFFSET ${offset}`, params),
  ]);

  const total = get(totalResult, 'dataValues.total', 0);
  return { total, collectives };
};

export const usersToNotifyForUpdateSQLQuery = `
  WITH collective AS (
    SELECT c.*
    FROM "Collectives" c
    WHERE id = :collectiveId OR "ParentCollectiveId" = :collectiveId
  ), hosted_collectives AS (
    SELECT hc.*
    FROM "Collectives" hc
    INNER JOIN "Members" m ON hc.id = m."CollectiveId"
    INNER JOIN "Collectives" mc ON mc."id" = m."CollectiveId"
    INNER JOIN collective c ON m."MemberCollectiveId" = c.id
    WHERE :includeHostedAccounts = TRUE
    AND c."isHostAccount" = TRUE
    AND m."role" = 'HOST'
    AND m."deletedAt" IS NULL
    AND mc."isActive" IS TRUE
    AND mc."approvedAt" IS NOT NULL
    GROUP BY hc.id
  ), member_collectives AS (
    SELECT mc.*
    FROM "Members" m
    INNER JOIN "Collectives" mc ON m."MemberCollectiveId" = mc.id
    CROSS JOIN collective
    WHERE m."deletedAt" IS NULL
    AND mc."deletedAt" IS NULL
    AND (
      (
        -- Direct members
        :includeMembers = TRUE
        AND m."CollectiveId" = collective.id
        AND m."role" IN (:targetRoles)
      ) OR (
        -- Collective admins
        m."CollectiveId" = collective.id AND m."role" IN ('ADMIN', 'MEMBER')
      ) OR (
        -- Parent collective admins
        collective."ParentCollectiveId" IS NOT NULL
        AND m."CollectiveId" = collective."ParentCollectiveId"
        AND m."role" IN ('ADMIN', 'MEMBER')
      ) OR (
        --- Include child collective's contributors
        collective."ParentCollectiveId" = :collectiveId
        AND collective.id = m."CollectiveId"
        AND m."role" IN (:targetRoles)
      )
    )
    GROUP BY mc.id
  ), admins_of_members AS (
    -- For all member_collectives and hosted_collectives, get admin profiles
    SELECT mc.*
    FROM "Members" m
    INNER JOIN "Collectives" mc ON m."MemberCollectiveId" = mc.id
    LEFT JOIN member_collectives org_admin_collectives
      ON (
        org_admin_collectives."type" != 'USER'
        AND m."CollectiveId" = org_admin_collectives.id
      )
    LEFT JOIN hosted_collectives hosted_collective_admins
      ON (
        hosted_collective_admins."type" != 'USER'
        AND m."CollectiveId" = hosted_collective_admins.id
      )
    WHERE
      (org_admin_collectives.id IS NOT NULL OR hosted_collective_admins.id IS NOT NULL)
      AND m."role" IN ('ADMIN', 'MEMBER')
      AND m."deletedAt" IS NULL
      AND mc."type" = 'USER'
    GROUP BY
      mc.id
  ) SELECT u.id
  -- Get all user entries, either the direct members, the admins of member_collectives or the admins of parent collectives
  FROM "Users" u
  LEFT JOIN admins_of_members
    ON u."CollectiveId" = admins_of_members.id
  LEFT JOIN member_collectives
    ON (member_collectives."type" = 'USER' AND u."CollectiveId" = member_collectives.id)
  WHERE (admins_of_members.id IS NOT NULL OR member_collectives.id IS NOT NULL)
  AND u."deletedAt" IS NULL
  GROUP BY u.id
`;

export const countUsersToNotifyForUpdateSQLQuery = `
  SELECT COUNT(*) FROM (${usersToNotifyForUpdateSQLQuery}) AS users_to_notify
`;

export const countMembersToNotifyForUpdateSQLQuery = `
  WITH member_collectives_to_notify AS (
    SELECT mc.id, mc."type", array_agg(m."role")::text[] && ARRAY['ADMIN', 'MEMBER'] AS is_core_contributor
    FROM "Members" m
    INNER JOIN "Collectives" mc ON m."MemberCollectiveId" = mc.id
    FULL OUTER JOIN "Collectives" collective ON (collective.id = :collectiveId OR collective."ParentCollectiveId" = :collectiveId)
    WHERE m."deletedAt" IS NULL
    AND mc."deletedAt" IS NULL
    AND ((
        m."CollectiveId" = collective.id AND m."role" IN (:targetRoles)
      ) OR (
        -- Include parent collective's core contributors
        collective."ParentCollectiveId" IS NOT NULL
        AND m."CollectiveId" = collective."ParentCollectiveId"
        AND m."role" IN ('ADMIN', 'MEMBER')
      ) OR (
        --- Include child collective's contributors
        collective."ParentCollectiveId" = :collectiveId
        AND collective.id = m."CollectiveId"
        AND m."role" IN (:targetRoles)
      )
    )
    GROUP BY mc.id
  ) SELECT
    CASE WHEN is_core_contributor IS TRUE THEN 'CORE_CONTRIBUTOR' ELSE "type" END AS "type",
    COUNT(*) AS "count"
  FROM
    member_collectives_to_notify
  GROUP BY
    CASE WHEN is_core_contributor IS TRUE THEN 'CORE_CONTRIBUTOR' ELSE "type" END
`;

/**
 * Get list of all unique tags for collectives.
 */
const getUniqueCollectiveTags = () => {
  return sequelize
    .query(
      `
    WITH
      tags as (
        SELECT UNNEST(tags) as tag FROM "Collectives" WHERE type='COLLECTIVE' AND ARRAY_LENGTH(tags, 1) > 0
      ),
      top_tags as (
        SELECT tag, count(*) as count FROM tags GROUP BY tag ORDER BY count DESC
      )
    SELECT * FROM top_tags WHERE count > 20 ORDER BY tag ASC
  `,
    )
    .then(results => results[0].map(x => x.tag));
};

/**
 * Get list of all unique batches for collective.
 * Returns an array of objects matching `PaymentMethodBatchInfo`
 */
const getGiftCardBatchesForCollective = async collectiveId => {
  return sequelize.query(
    `
    SELECT
      :collectiveId::varchar || '-giftcard-' || COALESCE(pm.batch, ' __UNGROUPED__ ') AS id,
      :collectiveId AS "collectiveId",
      'giftcard' AS type,
      pm.batch AS name,
      COUNT(pm.id) as count
    FROM "PaymentMethods" pm
    INNER JOIN "PaymentMethods" spm ON pm."SourcePaymentMethodId" = spm.id
    WHERE spm."CollectiveId" = :collectiveId
    GROUP BY pm.batch
    ORDER BY pm.batch ASC
  `,
    {
      raw: true,
      type: sequelize.QueryTypes.SELECT,
      replacements: { collectiveId },
    },
  );
};

/**
 * Returns top sponsors in the past 3 months ordered by total amount donated and number of collectives they sponsor
 * (excluding open source collective id 9805 and sponsors that have sponsored only one collective)
 */
const getTopSponsors = () => {
  const d = new Date();
  d.setMonth(d.getMonth() - 3);
  return sequelize
    .query(
      `
      WITH
      "topSponsorsLast3Months" as (
        SELECT "CollectiveId", MAX(c.slug) as slug, MAX(c.type) as type, MAX(c.name) as name, MAX(c.description) as description, MAX(c.image) as image, -SUM(amount) as "totalDonationsLast3months", MAX(c.currency) as currency, COUNT(DISTINCT t."FromCollectiveId") as collectives
        FROM "Collectives" c LEFT JOIN "Transactions" t ON t."CollectiveId" = c.id
        WHERE c.type = 'ORGANIZATION'
          AND t.type='DEBIT'
          AND t.currency='USD'
          AND t."platformFeeInHostCurrency" < 0
          AND c.id != 9805
          AND t."createdAt" > :since
        GROUP BY t."CollectiveId"
        ORDER BY "totalDonationsLast3months" DESC, collectives DESC LIMIT 20
      ),
      "topSponsorsTotalDonations" as (
        SELECT -sum(amount) as "totalDonations", max(t."CollectiveId") as "CollectiveId"
        FROM "Transactions" t WHERE t."CollectiveId" IN (
          SELECT s."CollectiveId" FROM "topSponsorsLast3Months" s WHERE s.collectives > 1 LIMIT 6
        )
        GROUP BY t."CollectiveId"
      )
      SELECT d."totalDonations", s."totalDonationsLast3months", s.*
      FROM "topSponsorsLast3Months" s
      LEFT JOIN "topSponsorsTotalDonations" d ON d."CollectiveId" = s."CollectiveId"
      WHERE collectives > 1
      ORDER BY d."totalDonations" DESC NULLS LAST
      LIMIT :limit
    `.replace(/\s\s+/g, ' '), // this is to remove the new lines and save log space.
      {
        replacements: { limit: 6, since: d },
        type: sequelize.QueryTypes.SELECT,
      },
    )
    .then(sponsors =>
      sponsors.map(sponsor => {
        sponsor.publicUrl = `${config.host.website}/${sponsor.slug}`;
        return sponsor;
      }),
    );
};

/**
 * Returns collectives ordered by average monthly spending in the last 90 days
 * excluding:
 * - id 9805 (open source collective host)
 * - id 1 (opencollective-company)
 * - id 51 and 9804 (wwcode host)
 */
const getCollectivesOrderedByMonthlySpendingQuery = async ({
  where = {},
  orderDirection = 'ASC',
  limit = 0,
  offset = 0,
}) => {
  const whereStatement = Object.keys(where).reduce((statement, key) => `${statement} AND c."${key}"=:${key}`, '');

  const d = new Date();
  const since = new Date(d.setDate(d.getDate() - 90));

  const params = {
    replacements: { ...where, since },
    model: models.Collective,
  };

  const sql = fields =>
    `
    SELECT c.id,
    (CASE
      WHEN (DATE_PART('day', max(t."createdAt") - min(t."createdAt")) < 30) THEN -SUM(amount)
      WHEN (DATE_PART('day', max(t."createdAt") - min(t."createdAt")) < 60) THEN -SUM(amount) / 2
      ELSE -SUM(amount) / 3
    END) as "monthlySpending",
    ${fields}
    FROM "Collectives" c
    LEFT JOIN "Transactions" t on t."CollectiveId" = c.id
    WHERE c."isActive" IS TRUE
      AND c."deletedAt" IS NULL
      AND c.id NOT IN (1, 51, 9804, 9805)
      AND t."deletedAt" IS NULL
      AND t."type" = 'DEBIT'
      AND t."createdAt" >= :since
      ${whereStatement}
    GROUP BY c.id
    ORDER BY "monthlySpending" ${orderDirection} NULLS LAST
  `.replace(/\s\s+/g, ' ');

  // If we use this query to get the monthlySpending of one single collective, we don't need to perform a count query
  const countPromise =
    typeof where.id === 'number'
      ? Promise.resolve(1)
      : sequelize
          .query(`${sql('COUNT(c.*) OVER() as "total"')} LIMIT 1`, params)
          .then(res => res.length === 1 && res[0].dataValues.total);

  const [total, collectives] = await Promise.all([
    countPromise,
    sequelize.query(`${sql('c.*')} LIMIT ${limit} OFFSET ${offset}`, params),
  ]);

  return { total, collectives };
};

const getMembersOfCollectiveWithRole = CollectiveIds => {
  const collectiveids = typeof CollectiveIds === 'number' ? [CollectiveIds] : CollectiveIds;
  return sequelize.query(
    `
    WITH memberships AS (
      SELECT c.*, MAX(u.email) as email, string_agg(distinct m.role,',') as roles
      FROM "Collectives" c
        LEFT JOIN "Members" m ON c.id = m."MemberCollectiveId"
        LEFT JOIN "Users" u ON u."CollectiveId" = c.id
      WHERE m."CollectiveId" IN (:collectiveids) AND m."deletedAt" IS NULL AND c."deletedAt" IS NULL
      GROUP BY c.id
    )
    SELECT (CASE WHEN roles LIKE '%HOST%' THEN 'HOST' WHEN roles LIKE '%ADMIN%' THEN 'ADMIN' ELSE 'BACKER' END) as role, * FROM memberships
`,
    {
      replacements: { collectiveids },
      type: sequelize.QueryTypes.SELECT,
      model: models.Collective,
    },
  );
};

/**
 * Returns all the members of a collective with their `totalDonations` and
 * `role` (HOST/ADMIN/BACKER)
 */
const getMembersWithTotalDonations = (where, options = {}) => {
  const untilCondition = table => {
    let condition = '';
    if (options.since) {
      condition += `AND ${table}."createdAt" >= '${options.since.toISOString().toString().substr(0, 10)}'`;
    }
    if (options.until) {
      condition += `AND ${table}."createdAt" < '${options.until.toISOString().toString().substr(0, 10)}'`;
    }
    return condition;
  };

  const roleCond = where.role ? `AND member.role = :role` : '';

  let types,
    filterByMemberCollectiveType = '';
  if (options.type) {
    types = typeof options.type === 'string' ? options.type.split(',') : options.type;
    filterByMemberCollectiveType = 'AND c.type IN (:types)';
  }

  let memberCondAttribute, transactionType, groupBy;
  if (where.CollectiveId) {
    memberCondAttribute = 'CollectiveId';
    transactionType = 'CREDIT';
    groupBy = 'MemberCollectiveId';
  } else if (where.MemberCollectiveId) {
    memberCondAttribute = 'MemberCollectiveId';
    transactionType = 'DEBIT';
    groupBy = 'CollectiveId';
  }
  const collectiveids =
    typeof where[memberCondAttribute] === 'number' ? [where[memberCondAttribute]] : where[memberCondAttribute];

  const selector = `member."${groupBy}" as "${groupBy}", max(member."${memberCondAttribute}") as "${memberCondAttribute}"`;

  // Stats query builder to get stats about transactions
  const buildTransactionsStatsQuery = sourceCollectiveIdColName => `
    SELECT
      "${sourceCollectiveIdColName}",
      ${
        transactionType === 'DEBIT' ? 'SUM("netAmountInCollectiveCurrency") * -1' : 'SUM("amount")'
      } as "totalDonations",
      max("createdAt") as "lastDonation",
      min("createdAt") as "firstDonation"
    FROM "Transactions" t
    WHERE t."CollectiveId" IN (:collectiveids)
    AND t.amount ${transactionType === 'CREDIT' ? '>=' : '<='} 0 ${untilCondition('t')}
    AND t."deletedAt" IS NULL
    GROUP BY t."${sourceCollectiveIdColName}"
  `;

  const query = `
    WITH
      DirectStats AS (
        ${buildTransactionsStatsQuery('FromCollectiveId')}
      ),
      IndirectStats AS (
        ${buildTransactionsStatsQuery('UsingGiftCardFromCollectiveId')}
      )
    SELECT
      ${selector},
      member.role,
      max(member.id) as "MemberId",
      max(member."TierId") as "TierId",
      max(member."createdAt") as "createdAt",
      max(c.id) as id,
      max(c.type) as type,
      max(c."HostCollectiveId") as "HostCollectiveId",
      max(c."ParentCollectiveId") as "ParentCollectiveId",
      max(c.name) as name,
      max(c.description) as description,
      max(c.slug) as slug,
      max(c.image) as image,
      max(c.website) as website,
      max(c.currency) as currency,
      max(u.email) as email,
      max(c."twitterHandle") as "twitterHandle",
      COALESCE(max(dstats."totalDonations"), 0) as "directDonations",
      COALESCE(max(dstats."totalDonations"), 0) +  COALESCE(max(istats."totalDonations"), 0) as "totalDonations",
      LEAST(Max(dstats."firstDonation"), Max(istats."firstDonation")) AS "firstDonation",
      GREATEST(Max(dstats."lastDonation"), Max(istats."lastDonation")) AS "lastDonation"
    FROM "Collectives" c
    LEFT JOIN DirectStats dstats ON c.id = dstats."FromCollectiveId"
    LEFT JOIN IndirectStats istats ON c.id = istats."UsingGiftCardFromCollectiveId"
    LEFT JOIN "Members" member ON c.id = member."${groupBy}"
    LEFT JOIN "Users" u ON c.id = u."CollectiveId"
    WHERE member."${memberCondAttribute}" IN (:collectiveids)
    ${roleCond}
    AND member."deletedAt" IS NULL ${untilCondition('member')}
    ${filterByMemberCollectiveType}
    GROUP BY member.role, member."${groupBy}"
    ORDER BY "totalDonations" DESC, "createdAt" ASC
    LIMIT :limit OFFSET :offset
  `;

  return sequelize.query(
    query.replace(/\s\s+/g, ' '), // this is to remove the new lines and save log space.
    {
      replacements: {
        collectiveids,
        limit: options.limit || 100000, // we should reduce this to 100 by default but right now Webpack depends on it
        offset: options.offset || 0,
        types,
        role: where.role,
      },
      type: sequelize.QueryTypes.SELECT,
      model: models.Collective,
    },
  );
};

const getMembersWithBalance = (where, options = {}) => {
  const { until } = options;
  const untilCondition = table =>
    until ? `AND ${table}."createdAt" < '${until.toISOString().toString().substr(0, 10)}'` : '';
  const roleCond = where.role ? `AND member.role = :role` : '';

  let types,
    filterByMemberCollectiveType = '';
  if (options.type) {
    types = typeof options.type === 'string' ? options.type.split(',') : options.type;
    filterByMemberCollectiveType = 'AND c.type IN (:types)';
  }

  let whereCondition = '';
  Object.keys(pick(where, ['HostCollectiveId', 'ParentCollectiveId'])).forEach(key => {
    whereCondition += `AND c."${key}"=:${key} `;
  });

  let memberCondAttribute, groupBy;
  if (where.CollectiveId) {
    memberCondAttribute = 'CollectiveId';
    groupBy = 'MemberCollectiveId';
  } else if (where.MemberCollectiveId) {
    memberCondAttribute = 'MemberCollectiveId';
    groupBy = 'CollectiveId';
  }
  const collectiveids =
    typeof where[memberCondAttribute] === 'number' ? [where[memberCondAttribute]] : where[memberCondAttribute];
  const selector = `member."${groupBy}" as "${groupBy}", max(member."${memberCondAttribute}") as "${memberCondAttribute}"`;

  // xdamman: this query can be optimized by first computing all the memberships
  // and only computing the balance for the member.collective selected #TODO
  const query = `
    with "balance" AS (
      SELECT t."CollectiveId", SUM("netAmountInCollectiveCurrency") as "balance"
      FROM "Collectives" c
      LEFT JOIN "Transactions" t ON t."CollectiveId" = c.id
      WHERE
        c.type = 'COLLECTIVE'
        AND c."isActive" IS TRUE
        ${whereCondition}
        AND c."deletedAt" IS NULL
        GROUP BY t."CollectiveId"
    )
    SELECT
      ${selector},
      member.role,
      max(member.id) as "MemberId",
      max(member."TierId") as "TierId",
      max(member."createdAt") as "createdAt",
      max(c.id) as id,
      max(c.type) as type,
      max(c."HostCollectiveId") as "HostCollectiveId",
      max(c."ParentCollectiveId") as "ParentCollectiveId",
      max(c.name) as name,
      max(c.slug) as slug,
      max(c.image) as image,
      max(c.website) as website,
      max(c.currency) as currency,
      max(u.email) as email,
      max(c."twitterHandle") as "twitterHandle",
      COALESCE(max(b."balance"), 0) as "balance"
    FROM "Collectives" c
    LEFT JOIN balance b ON c.id = b."CollectiveId"
    LEFT JOIN "Members" member ON c.id = member."${groupBy}"
    LEFT JOIN "Users" u ON c.id = u."CollectiveId"
    WHERE member."${memberCondAttribute}" IN (:collectiveids)
    ${roleCond}
    ${whereCondition}
    AND member."deletedAt" IS NULL ${untilCondition('member')}
    ${filterByMemberCollectiveType}
    GROUP BY member.role, member."${groupBy}"
    ORDER BY "balance" DESC, "createdAt" ASC
    LIMIT :limit OFFSET :offset
  `;

  const replacements = {
    ...where,
    collectiveids,
    limit: options.limit || 100000, // we should reduce this to 100 by default but right now Webpack depends on it
    offset: options.offset || 0,
    types,
  };

  return sequelize.query(
    query.replace(/\s\s+/g, ' '), // this is to remove the new lines and save log space.
    {
      replacements,
      type: sequelize.QueryTypes.SELECT,
      model: models.Collective,
    },
  );
};

const getTotalNumberOfActiveCollectives = (since, until) => {
  const sinceClause = since ? `AND t."createdAt" >= '${since.toISOString()}'` : '';
  const untilClause = until ? `AND t."createdAt" < '${until.toISOString()}'` : '';
  return sequelize
    .query(
      `
    SELECT COUNT(DISTINCT("CollectiveId")) as count
    FROM "Transactions" t
      LEFT JOIN "Collectives" c ON t."CollectiveId" = c.id
    WHERE c.type='COLLECTIVE' ${sinceClause} ${untilClause}
  `,
      {
        type: sequelize.QueryTypes.SELECT,
      },
    )
    .then(res => parseInt(res[0].count));
};

const getTotalNumberOfDonors = () => {
  return sequelize
    .query(
      `
    SELECT COUNT(DISTINCT("FromCollectiveId")) as count
    FROM "Transactions" t
      LEFT JOIN "Collectives" c ON t."CollectiveId" = c.id
    WHERE c.type='COLLECTIVE'
  `,
      {
        type: sequelize.QueryTypes.SELECT,
      },
    )
    .then(res => parseInt(res[0].count));
};

const getCollectivesWithMinBackersQuery = async ({
  backerCount = 10,
  orderBy = 'createdAt',
  orderDirection = 'ASC',
  limit = 0,
  offset = 0,
  where = {},
}) => {
  if (where.type) {
    delete where.type;
  }

  const whereStatement = Object.keys(where).reduce((statement, key) => `${statement} AND c."${key}"=$${key}`, '');
  const params = {
    bind: where,
    model: models.Collective,
  };

  const sql = fields =>
    `
    with "actives" as (
      SELECT c.id
      FROM "Collectives" c
      LEFT JOIN "Members" m ON m."CollectiveId" = c.id
      WHERE
        c.type = 'COLLECTIVE'
        AND c."isActive" IS TRUE
        AND c."deletedAt" IS NULL
        AND m.role = 'BACKER'
        ${whereStatement}
        GROUP BY c.id
        HAVING count(m."MemberCollectiveId") >= ${backerCount}
    )
    SELECT ${fields} from "Collectives" c
    INNER JOIN "actives" a on a.id = c.id
    ORDER BY c."${orderBy}" ${orderDirection} NULLS LAST
  `.replace(/\s\s+/g, ' ');

  const [[totalResult], collectives] = await Promise.all([
    sequelize.query(`${sql('COUNT(c.*) OVER() as "total"')} LIMIT 1`, params),
    sequelize.query(`${sql('c.*')} LIMIT ${limit} OFFSET ${offset}`, params),
  ]);

  const total = totalResult ? get(totalResult, 'dataValues.total') : 0;

  return { total, collectives };
};

/**
 * Goes through the results of a tax form query and returns the set of IDs (defined by `idKey`)
 * that require a tax form.
 *
 * Example:
 * > getTaxFormsOverTheLimit([{ ..., expenseId: 4242, payoutMethodType: 'OTHER', total: 1000e2 }], 'expenseId')
 * Set { 4242 }
 *
 * @argument {Object[]} results - The results of a tax form query.
 */
const getTaxFormsOverTheLimit = (results, idKey) => {
  // Group results in a map like Map<idKey, { paypalTotal, otherTotal }>
  const groupedResults = new Map();
  for (const result of results) {
    if (result.requiredDocument === 'US_TAX_FORM' && result.legalDocRequestStatus !== 'RECEIVED') {
      const groupResult = groupedResults.get(result[idKey]) || { paypalTotal: 0, otherTotal: 0 };
      const totalKey = result.payoutMethodType === PayoutMethodTypes.PAYPAL ? 'paypalTotal' : 'otherTotal';
      groupResult[totalKey] += result.total;
      groupedResults.set(result[idKey], groupResult);
    }
  }

  // Filter entries in the map to return a set with only the IDs that require a tax form (over the limits)
  const resultSet = new Set();
  groupedResults.forEach((groupResult, id) => {
    if (amountsRequireTaxForm(groupResult.paypalTotal, groupResult.otherTotal)) {
      resultSet.add(id);
    }
  });

  return resultSet;
};

/**
 * @returns Set<number> - expenses IDs where a tax form is required
 */
const getTaxFormsRequiredForExpenses = async expenseIds => {
  const results = await sequelize.query(
    `
    SELECT
      analyzed_expenses."FromCollectiveId",
      analyzed_expenses.id as "expenseId",
      MAX(ld."requestStatus") as "legalDocRequestStatus",
      d."documentType" as "requiredDocument",
      SUM(all_expenses."amount") AS total,
      COALESCE(pm."type", 'OTHER') AS "payoutMethodType"
    FROM
      "Expenses" analyzed_expenses
    INNER JOIN "Expenses" all_expenses
      ON all_expenses."FromCollectiveId" = analyzed_expenses."FromCollectiveId"
    INNER JOIN "Collectives" from_collective
      ON from_collective.id = analyzed_expenses."FromCollectiveId"
    INNER JOIN "Collectives" c
      ON c.id = analyzed_expenses."CollectiveId"
    INNER JOIN "RequiredLegalDocuments" d
      ON d."HostCollectiveId" = c."HostCollectiveId"
      AND d."documentType" = 'US_TAX_FORM'
    INNER JOIN "Collectives" all_expenses_collectives
      ON all_expenses_collectives.id = all_expenses."CollectiveId"
      AND all_expenses_collectives."HostCollectiveId" = d."HostCollectiveId"
    LEFT JOIN "LegalDocuments" ld
      ON ld.year + :validityInYears >= date_part('year', analyzed_expenses."incurredAt")
      AND ld."documentType" = 'US_TAX_FORM'
      AND ld."requestStatus" = 'RECEIVED'
      AND (
        ld."CollectiveId" = from_collective.id -- Either use the payee's legal document
        OR (from_collective."HostCollectiveId" IS NOT NULL AND ld."CollectiveId" = from_collective."HostCollectiveId") -- Or the host's legal document
      )
    LEFT JOIN "PayoutMethods" pm
      ON all_expenses."PayoutMethodId" = pm.id
    WHERE analyzed_expenses.id IN (:expenseIds)
    AND analyzed_expenses."FromCollectiveId" != d."HostCollectiveId"
    AND analyzed_expenses.type NOT IN (:ignoredExpenseTypes)
    AND analyzed_expenses.status IN ('PENDING', 'APPROVED')
    AND analyzed_expenses."deletedAt" IS NULL
    AND (from_collective."HostCollectiveId" IS NULL OR from_collective."HostCollectiveId" != c."HostCollectiveId")
    AND all_expenses.type NOT IN (:ignoredExpenseTypes)
    AND all_expenses.status NOT IN (:ignoredExpenseStatuses)
    AND all_expenses."deletedAt" IS NULL
    AND date_trunc('year', all_expenses."incurredAt") = date_trunc('year', analyzed_expenses."incurredAt")
    AND ld.id IS NULL -- Ignore documents that have already been received
    GROUP BY analyzed_expenses.id, analyzed_expenses."FromCollectiveId", d."documentType", COALESCE(pm."type", 'OTHER')
  `,
    {
      type: sequelize.QueryTypes.SELECT,
      raw: true,
      replacements: {
        expenseIds,
        validityInYears: US_TAX_FORM_VALIDITY_IN_YEARS,
        ignoredExpenseTypes: TAX_FORM_IGNORED_EXPENSE_TYPES,
        ignoredExpenseStatuses: TAX_FORM_IGNORED_EXPENSE_STATUSES,
      },
    },
  );

  return getTaxFormsOverTheLimit(results, 'expenseId');
};

/**
 * @returns number[] - collective IDs where a tax form is required
 */
const getTaxFormsRequiredForAccounts = async (accountIds = [], year) => {
  const results = await sequelize.query(
    `
    SELECT
      account.id as "collectiveId",
      MAX(ld."requestStatus") as "legalDocRequestStatus",
      d."documentType" as "requiredDocument",
      SUM(all_expenses."amount") AS total,
      COALESCE(pm."type", 'OTHER') AS "payoutMethodType"
    FROM "Collectives" account
    INNER JOIN "Expenses" all_expenses
      ON all_expenses."FromCollectiveId" = account.id
    INNER JOIN "Collectives" c
      ON all_expenses."CollectiveId" = c.id
    INNER JOIN "RequiredLegalDocuments" d
      ON d."HostCollectiveId" = c."HostCollectiveId"
      AND d."documentType" = 'US_TAX_FORM'
    LEFT JOIN "LegalDocuments" ld
      ON ld.year + :validityInYears >= :year
      AND ld."documentType" = 'US_TAX_FORM'
      AND ld."requestStatus" = 'RECEIVED'
      AND (
        ld."CollectiveId" = account.id -- Either use the account's legal document
        OR (account."HostCollectiveId" IS NOT NULL AND ld."CollectiveId" = account."HostCollectiveId") -- Or the host's legal document
      )
    LEFT JOIN "PayoutMethods" pm
      ON all_expenses."PayoutMethodId" = pm.id
    WHERE all_expenses.type NOT IN (:ignoredExpenseTypes)
    ${ifStr(accountIds?.length, 'AND account.id IN (:accountIds)')}
    AND account.id != d."HostCollectiveId"
    AND (account."HostCollectiveId" IS NULL OR account."HostCollectiveId" != d."HostCollectiveId") -- Ignore tax forms when the submitter is hosted by a host that has tax form enabled (OCF, OSC, OC)
    AND all_expenses.status NOT IN (:ignoredExpenseStatuses)
    AND all_expenses."deletedAt" IS NULL
    AND EXTRACT('year' FROM all_expenses."incurredAt") = :year
    AND ld.id IS NULL -- Ignore documents that have already been received
    GROUP BY account.id, d."documentType", COALESCE(pm."type", 'OTHER')
  `,
    {
      raw: true,
      type: sequelize.QueryTypes.SELECT,
      replacements: {
        accountIds,
        year: year,
        validityInYears: US_TAX_FORM_VALIDITY_IN_YEARS,
        ignoredExpenseTypes: TAX_FORM_IGNORED_EXPENSE_TYPES,
        ignoredExpenseStatuses: TAX_FORM_IGNORED_EXPENSE_STATUSES,
      },
    },
  );

  return getTaxFormsOverTheLimit(results, 'collectiveId');
};

const serializeCollectivesResult = JSON.stringify;

const unserializeCollectivesResult = string => {
  const result = JSON.parse(string);
  result.collectives = result.collectives.map(collective => models.Collective.build(collective));
  return result;
};

const getCollectivesOrderedByMonthlySpending = memoize(getCollectivesOrderedByMonthlySpendingQuery, {
  key: 'collectives_ordered_by_monthly_spending',
  maxAge: twoHoursInSeconds,
  serialize: serializeCollectivesResult,
  unserialize: unserializeCollectivesResult,
});

const getCollectivesWithMinBackers = memoize(getCollectivesWithMinBackersQuery, {
  key: 'collectives_with_min_backers',
  maxAge: twoHoursInSeconds,
  serialize: serializeCollectivesResult,
  unserialize: unserializeCollectivesResult,
});

const queries = {
  getCollectivesOrderedByMonthlySpending,
  getCollectivesOrderedByMonthlySpendingQuery,
  getCollectivesWithBalance,
  getCollectivesWithMinBackers,
  getCollectivesWithMinBackersQuery,
  getHosts,
  getMembersOfCollectiveWithRole,
  getMembersWithBalance,
  getMembersWithTotalDonations,
  getTaxFormsRequiredForAccounts,
  getTaxFormsRequiredForExpenses,
  getTopBackers,
  getTopSponsors,
  getTotalAnnualBudget,
  getTotalAnnualBudgetForHost,
  getTotalNumberOfActiveCollectives,
  getTotalNumberOfDonors,
  getUniqueCollectiveTags,
  getGiftCardBatchesForCollective,
};

export default queries;
