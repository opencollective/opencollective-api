import { readFileSync } from 'fs';
import path from 'path';

import { pick, startCase } from 'lodash';

import models, { Collective, Op, sequelize } from '../models';
import { MigrationLogType } from '../models/MigrationLog';

/**
 * From a given account, returns its entire network of accounts: administrated profiles,
 * other profiles administrated by the same admins, etc...
 */
export const getAccountsNetwork = async (accounts: Collective[]): Promise<Collective[]> => {
  if (!accounts?.length) {
    return [];
  }

  return sequelize.query(
    `
    WITH RECURSIVE profiles AS (
      -- Requested profiles
      SELECT id, "ParentCollectiveId", type, slug, name
      FROM "Collectives"
      WHERE "slug" IN (:slugs)
      AND "deletedAt" IS NULL
      -- Recursively get all administrators/administrated profiles
      UNION
      SELECT c.id, c."ParentCollectiveId", c.type, c.slug, c.name
      FROM "Collectives" mc
      INNER JOIN profiles
        ON profiles.id = mc.id -- Get all profiles previously returned + their children
        OR profiles."ParentCollectiveId" = mc.id
      INNER JOIN "Members" m
        ON m."deletedAt" IS NULL
        AND m.role = 'ADMIN'
        AND (
          m."MemberCollectiveId" = mc.id -- Administrators of this profile
          OR m."CollectiveId" = mc.id -- Administrated profiles
        )
      INNER JOIN "Collectives" c ON c."deletedAt" IS NULL AND (m."CollectiveId" = c.id OR m."MemberCollectiveId" = c.id)
    ) SELECT *
    FROM profiles
    INNER JOIN "Collectives" c ON c.id = profiles.id
    ORDER BY c.name, c.slug
  `,
    {
      type: sequelize.QueryTypes.SELECT,
      model: models.Collective,
      mapToModel: true,
      replacements: {
        slugs: accounts.map(a => a.slug),
      },
    },
  );
};

type BanSummary = {
  undeletableTransactionsCount: number;
  transactionsCount: number;
  expensesCount: number;
  ordersCount: number;
  newOrdersCount: number;
  usersCount: number;
};

const allTransactionGroupsForAccountQuery = `
  SELECT DISTINCT "TransactionGroup"
  FROM "Transactions" t
  WHERE t."deletedAt" IS NULL
  AND (
    t."CollectiveId" IN (:collectiveIds)
    OR t."FromCollectiveId" IN (:collectiveIds)
    OR t."HostCollectiveId" IN (:collectiveIds)
  )
`;

const getAllRelatedTransactionsCount = async collectiveIds => {
  const result = await sequelize.query(
    `
    WITH transaction_groups AS (
      ${allTransactionGroupsForAccountQuery}
    ) SELECT COUNT(id) AS "count"
    FROM "Transactions" t
    WHERE t."TransactionGroup" IN (SELECT "TransactionGroup" FROM transaction_groups)
    AND t."deletedAt" IS NULL
  `,
    {
      plain: true,
      replacements: { collectiveIds },
    },
  );

  return result.count;
};

const getUndeletableTransactionsCount = async collectiveIds => {
  const result = await sequelize.query(
    `
    -- Get all transactions groups somehow associated with this collective
    WITH transaction_groups AS (
      ${allTransactionGroupsForAccountQuery}
    ) SELECT COUNT(t.id) AS "count"
    FROM "Transactions" t
    LEFT JOIN "PaymentMethods" pm ON pm.id = t."PaymentMethodId"
    LEFT JOIN "Expenses" e ON e.id = t."ExpenseId"
    LEFT JOIN "PayoutMethods" payout ON payout.id = e."PayoutMethodId"
    WHERE t."TransactionGroup" IN (SELECT "TransactionGroup" FROM transaction_groups)
    AND t."deletedAt" IS NULL
    AND
      CASE WHEN t."PaymentMethodId" IS NOT NULL THEN (
        -- If there is a payment method, filter to only include cases where money actually moved in the real world
        pm."SourcePaymentMethodId" IS NOT NULL -- Gift cards transactions can't be deleted. We could be a bit more clever by looking at the source payment method service, but this is good enough for now.
        OR pm.service != 'opencollective'  -- Ignore only Open Collective transactions (added funds, collective to collective, etc.) - money did not really move
      ) WHEN t."ExpenseId" IS NOT NULL THEN (
        -- For expenses, we need to check the payout info
        (e."legacyPayoutMethod" = 'paypal' AND e."PayoutMethodId" IS NULL) -- Legacy paypal transactions with expenses - let's be safe and not delete them
        OR e."PayoutMethodId" IS NULL -- Manual payments
        OR (
          payout.type NOT IN ('OTHER', 'ACCOUNT_BALANCE')
          AND (
            (e."VirtualCardId" IS NOT NULL) -- Can't delete virtual cards-related transactions
            OR (payout.type = 'BANK_ACCOUNT' AND t.data -> 'transfer' IS NOT NULL) -- Can't delete wise transactions that were not paid manually
            OR (payout.type = 'PAYPAL' AND (t.data -> 'links' IS NOT NULL OR t.data -> 'createPaymentResponse' IS NOT NULL)) -- Can't delete paypal transactions that were not paid manually
          )
        )
      ) ELSE FALSE -- No payment/payout info, let's assume it's a manual transaction
    END
  `,
    {
      plain: true,
      replacements: { collectiveIds },
    },
  );

  return result.count;
};

export const getBanSummary = async (accounts: Collective[]): Promise<BanSummary> => {
  const collectiveIds = accounts.map(a => a.id);
  return {
    undeletableTransactionsCount: await getUndeletableTransactionsCount(collectiveIds),
    transactionsCount: await getAllRelatedTransactionsCount(collectiveIds),
    usersCount: accounts.filter(({ type }) => type === 'USER').length,
    expensesCount: await models.Expense.count({
      where: { [Op.or]: [{ CollectiveId: collectiveIds }, { FromCollectiveId: collectiveIds }] },
    }),
    ordersCount: await models.Order.count({
      where: { [Op.or]: [{ CollectiveId: collectiveIds }, { FromCollectiveId: collectiveIds }] },
    }),
    newOrdersCount: await models.Order.count({
      where: { [Op.or]: [{ CollectiveId: collectiveIds }, { FromCollectiveId: collectiveIds }], status: 'NEW' },
    }),
  };
};

export const stringifyBanSummary = (banSummary: BanSummary) => {
  if (banSummary.undeletableTransactionsCount) {
    return `Can't proceed: there are ${banSummary.undeletableTransactionsCount} undeletable transactions in this batch`;
  } else if (banSummary.newOrdersCount) {
    return `Can't proceed: there are ${banSummary.newOrdersCount} orders with a pending payment not yet synchronized`;
  }

  const countFields = Object.keys(banSummary).filter(key => key.endsWith('Count'));
  const allCounts = Object.entries(pick(banSummary, countFields));
  const positiveCounts = allCounts.filter(([, value]) => value > 0);
  if (positiveCounts.length === 0) {
    return 'No important data will be deleted';
  }

  const listStr = positiveCounts.map(([key, value]) => `- ${startCase(key.replace('Count', ''))}: ${value}`).join('\n');
  return `The following entities will be deleted (this estimation does not include updates, comments and other non-critical models):\n${listStr}`;
};

type BanResult = Record<string, number>;

/**
 * A wrapper around the ban-collectives.sql query. Use carefully!
 */
export const banAccounts = (accounts: Collective[], userId: number): Promise<BanResult> => {
  const banCollectivesQuery = readFileSync(path.join(__dirname, '../../sql/ban-collectives.sql'), 'utf8');

  return sequelize.transaction(async transaction => {
    const result = await sequelize.query(banCollectivesQuery, {
      bind: { collectiveSlugs: accounts.map(c => c.slug) },
      plain: true,
      transaction,
    });

    await models.MigrationLog.create(
      {
        type: MigrationLogType.BAN_ACCOUNTS,
        description: `Ban ${accounts.length} accounts`,
        CreatedByUserId: userId,
        data: {
          result,
          accounts: accounts.map(a => pick(a, ['id', 'slug', 'name', 'type'])),
        },
      },
      { transaction },
    );

    return result;
  });
};

/**
 * Transforms a result map as returned by the banCollectivesQuery query into a string like:
 * - Deleted Orders: 1
 * - Deleted Expenses: 2
 */
export const stringifyBanResult = (result: BanResult): string => {
  return Object.entries(result)
    .filter(([key, value]) => key.startsWith('nb_') && value > 0)
    .map(([key, value]) => `- ${startCase(key.replace('nb_', ''))}: ${value}`)
    .join('\n');
};
