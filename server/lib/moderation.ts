import { readFileSync } from 'fs';
import path from 'path';

import { pick, startCase } from 'lodash';

import { PAYMENT_METHOD_SERVICE } from '../constants/paymentMethods';
import models, { Op, sequelize } from '../models';
import { MigrationLogType } from '../models/MigrationLog';

/**
 * From a given account, returns its entire network of accounts: administrated profiles,
 * other profiles administrated by the same admins, etc...
 */
export const getAccountsNetwork = async (account: typeof models.Collective[]): Promise<typeof models.Collective[]> => {
  return sequelize.query(
    `
    WITH RECURSIVE profiles AS (
      -- Requested profiles
      SELECT id, type, slug, name
      FROM "Collectives"
      WHERE "slug" IN (:slugs)
      AND "deletedAt" IS NULL
      -- Recursively get all administrators/administrated profiles
      UNION
      SELECT c.id, c.type, c.slug, c.name
      FROM "Collectives" mc
      INNER JOIN profiles ON profiles.id = mc.id -- Get all profiles previously returned
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
        slugs: account.map(a => a.slug),
      },
    },
  );
};

type BanSummary = {
  undeletableTransactionsCount: number;
  transactionsCount: number;
  expensesCount: number;
  ordersCount: number;
  usersCount: number;
};

const getUndeletableTransactionsCount = async collectiveIds => {
  return models.Transaction.count({
    distinct: true,
    col: 'id',
    where: {
      [Op.or]: [
        { CollectiveId: collectiveIds },
        { FromCollectiveId: collectiveIds },
        { HostCollectiveId: collectiveIds },
      ],
    },
    include: [
      // Filter on payment methods to only include cases where money actually moved in the real world
      {
        association: 'PaymentMethod',
        required: true,
        where: {
          [Op.or]: [
            { SourcePaymentMethodId: { [Op.not]: null } }, // Gift cards transactions can't be deleted. We could be a bit more clever by looking at the source payment method type, but this is good enough for now.
            { service: { [Op.not]: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE } }, // Ignore only Open Collective transactions - money did not really move
          ],
        },
      },
      // Include related transactions
      { association: 'relatedTransactions', required: false },
    ],
  });
};

export const getBanSummary = async (accounts: typeof models.Collective[]): Promise<BanSummary> => {
  const collectiveIds = accounts.map(a => a.id);
  return {
    undeletableTransactionsCount: await getUndeletableTransactionsCount(collectiveIds),
    transactionsCount: await models.Transaction.count({
      distinct: true,
      col: 'id',
      where: {
        [Op.or]: [
          { CollectiveId: collectiveIds },
          { FromCollectiveId: collectiveIds },
          { HostCollectiveId: collectiveIds },
        ],
      },
      include: [{ association: 'relatedTransactions', required: false }],
    }),
    usersCount: accounts.filter(({ type }) => type === 'USER').length,
    expensesCount: await models.Expense.count({
      where: { [Op.or]: [{ CollectiveId: collectiveIds }, { FromCollectiveId: collectiveIds }] },
    }),
    ordersCount: await models.Order.count({
      where: { [Op.or]: [{ CollectiveId: collectiveIds }, { FromCollectiveId: collectiveIds }] },
    }),
  };
};

export const stringifyBanSummary = (banSummary: BanSummary) => {
  if (banSummary.undeletableTransactionsCount) {
    return `Can't proceed: there are ${banSummary.undeletableTransactionsCount} undeletable transactions in this batch`;
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
export const banAccounts = (accounts: typeof models.Collective[], userId: number): Promise<BanResult> => {
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
