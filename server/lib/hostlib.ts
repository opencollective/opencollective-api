import { intersection, sum } from 'lodash';
import pMap from 'p-map';
import { FindOptions, InferAttributes, QueryTypes } from 'sequelize';

import type { SupportedCurrency } from '../constants/currencies';
import { convertToCurrency, roundCentsAmount } from '../lib/currency';
import models, { Op, sequelize } from '../models';
import type Transaction from '../models/Transaction';

type TransactionWhere = NonNullable<FindOptions<InferAttributes<Transaction>>['where']> & {
  type?: string;
};

type TransactionSumRow = {
  amount: number;
  currency?: SupportedCurrency;
  hostCurrency?: SupportedCurrency;
};

export type BackersStats = {
  total: number;
  repeat: number;
  new: number;
  inactive: number;
};

export function getHostedCollectives(hostid: number, startDate: Date | string, endDate: Date = new Date()) {
  return sequelize.query(
    `
    with "members" as (
      SELECT m."CollectiveId"
      FROM "Members" m
      WHERE m.role='HOST'
        AND m."MemberCollectiveId" = :hostid
        AND (m."deletedAt" IS NULL OR m."deletedAt" > :startDate)
        AND m."createdAt" < :endDate
    ), "transactions" as (
      SELECT DISTINCT t."CollectiveId" FROM "Transactions" t WHERE t."HostCollectiveId" = :hostid AND t."createdAt" < :endDate AND t."createdAt" > :startDate
    )

    SELECT DISTINCT *
    FROM "Collectives" c
    WHERE
      c.id IN (SELECT "CollectiveId" FROM "members" UNION SELECT "CollectiveId" FROM "transactions")
      AND c."createdAt" < :endDate;
  `,
    {
      replacements: { hostid, endDate, startDate },
      model: models.Collective,
      type: QueryTypes.SELECT,
    },
  );
}

export function getBackersStats(
  startDate: Date = new Date('2015-01-01'),
  endDate: Date = new Date(),
  collectiveids?: number[],
): Promise<BackersStats> {
  const getBackersIds = (startDate: Date, endDate: Date) => {
    const where: TransactionWhere = {
      type: 'CREDIT',
      createdAt: { [Op.gte]: startDate, [Op.lt]: endDate },
    };

    if (collectiveids) {
      where.CollectiveId = { [Op.in]: collectiveids };
    }

    return models.Transaction.findAll({
      attributes: [[sequelize.fn('DISTINCT', sequelize.col('FromCollectiveId')), 'CollectiveId']],
      where,
    }).then(rows => rows.map(r => r.dataValues.CollectiveId));
  };

  const stats: BackersStats = { total: 0, repeat: 0, new: 0, inactive: 0 };

  return Promise.all([
    getBackersIds(new Date('2015-01-01'), endDate),
    getBackersIds(new Date('2015-01-01'), startDate),
    getBackersIds(startDate, endDate),
  ]).then(results => {
    stats.total = results[0].length;
    stats.repeat = intersection(results[1], results[2]).length;
    stats.new = results[2].length - stats.repeat;
    stats.inactive = stats.total - (stats.repeat + stats.new);
    return stats;
  });
}

export async function sumTransactionsBy(
  groupBy: string,
  attribute: string,
  query: FindOptions<InferAttributes<Transaction>>,
): Promise<TransactionSumRow[]> {
  const findAllQuery: FindOptions<InferAttributes<Transaction>> = {
    attributes: [[sequelize.fn('SUM', sequelize.fn('COALESCE', sequelize.col(attribute), 0)), 'amount'], groupBy],
    group: [`Transaction.${groupBy}`],
    ...query,
  };
  const transactions = await models.Transaction.findAll(findAllQuery);
  // when it's a raw query, the result is not in dataValues
  if (query.raw) {
    return transactions as TransactionSumRow[];
  } else {
    return transactions.map(r => r.dataValues);
  }
}

export function sumTransactionsByCurrency(
  attribute = 'netAmountInCollectiveCurrency',
  query: FindOptions<InferAttributes<Transaction>>,
) {
  const groupByCurrency = [
    'amountInHostCurrency',
    'paymentProcessorFeeInHostCurrency',
    'hostFeeInHostCurrency',
    'platformFeeInHostCurrency',
    'netAmountInHostCurrency',
  ].includes(attribute)
    ? 'hostCurrency'
    : 'currency';

  return sumTransactionsBy(groupByCurrency, attribute, query);
}

/**
 * Sum an attribute of the Transactions table and return the result by currency with the total in host currency
 *
 * @param attribute column to sum, e.g. 'netAmountInCollectiveCurrency' or 'hostFeeInHostCurrency'
 * @param query query clause to reduce the scope
 * @param hostCurrency currency of the host
 *
 * @post {
 *   byCurrency: [ { amount: Float!, currency: 'USD' }]
 *   totalInHostCurrency: Float!
 * }
 */
export async function sumTransactions(
  attribute: string,
  query: FindOptions<InferAttributes<Transaction>> = {},
  hostCurrency?: SupportedCurrency,
) {
  const amountsByCurrency = await sumTransactionsByCurrency(attribute, query);
  const targetCurrency: SupportedCurrency = hostCurrency || 'USD';
  const convertedAmounts = await pMap(amountsByCurrency, s =>
    convertToCurrency(s.amount, s.currency || s.hostCurrency, targetCurrency),
  );
  return {
    byCurrency: amountsByCurrency,
    totalInHostCurrency: roundCentsAmount(sum(convertedAmounts), targetCurrency), // in cents
  };
}

export function getTotalHostFees(
  collectiveids: number[],
  type?: string,
  startDate: Date = new Date('2015-01-01'),
  endDate: Date = new Date(),
  hostCurrency: SupportedCurrency = 'USD',
) {
  const where: TransactionWhere = {
    CollectiveId: { [Op.in]: collectiveids },
    createdAt: { [Op.gte]: startDate, [Op.lt]: endDate },
  };
  if (type) {
    where.type = type;
  }
  return sumTransactions('hostFeeInHostCurrency', { where }, hostCurrency);
}

export function getTotalNetAmount(
  collectiveids: number[],
  type?: string,
  startDate: Date = new Date('2015-01-01'),
  endDate: Date = new Date(),
  hostCurrency: SupportedCurrency = 'USD',
) {
  const where: TransactionWhere = {
    CollectiveId: { [Op.in]: collectiveids },
    createdAt: { [Op.gte]: startDate, [Op.lt]: endDate },
  };
  if (type) {
    where.type = type;
  }
  return sumTransactions('netAmountInCollectiveCurrency', { where }, hostCurrency);
}
