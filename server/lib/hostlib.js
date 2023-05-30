import { intersection, sum } from 'lodash';
import pMap from 'p-map';

import { convertToCurrency } from '../lib/currency';
import models, { Op, sequelize } from '../models';

export function getHostedCollectives(hostid, startDate, endDate = new Date()) {
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
      type: sequelize.QueryTypes.SELECT,
    },
  );
}

export function getBackersStats(startDate = new Date('2015-01-01'), endDate = new Date(), collectiveids) {
  const getBackersIds = (startDate, endDate) => {
    const where = {
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

  const stats = {};

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

export async function sumTransactionsBy(groupBy, attribute, query) {
  const findAllQuery = {
    attributes: [[sequelize.fn('SUM', sequelize.fn('COALESCE', sequelize.col(attribute), 0)), 'amount'], groupBy],
    group: [`Transaction.${groupBy}`],
    ...query,
  };
  const transactions = await models.Transaction.findAll(findAllQuery);
  // when it's a raw query, the result is not in dataValues
  if (query.raw) {
    return transactions;
  } else {
    return transactions.map(r => r.dataValues);
  }
}

export function sumTransactionsByCurrency(attribute = 'netAmountInCollectiveCurrency', query) {
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
 * @param {*} attribute column to sum, e.g. 'netAmountInCollectiveCurrency' or 'hostFeeInHostCurrency'
 * @param {*} query query clause to reduce the scope
 * @param {*} hostCurrency currency of the host
 *
 * @post {
 *   byCurrency: [ { amount: Float!, currency: 'USD' }]
 *   totalInHostCurrency: Float!
 * }
 */
export async function sumTransactions(attribute, query = {}, hostCurrency) {
  const amountsByCurrency = await sumTransactionsByCurrency(attribute, query);
  const convertedAmounts = await pMap(amountsByCurrency, s =>
    convertToCurrency(s.amount, s.currency || s.hostCurrency, hostCurrency || 'USD'),
  );
  return {
    byCurrency: amountsByCurrency,
    totalInHostCurrency: Math.round(sum(convertedAmounts)), // in cents
  };
}

export function getTotalHostFees(
  collectiveids,
  type,
  startDate = new Date('2015-01-01'),
  endDate = new Date(),
  hostCurrency = 'USD',
) {
  const where = {
    CollectiveId: { [Op.in]: collectiveids },
    createdAt: { [Op.gte]: startDate, [Op.lt]: endDate },
  };
  if (type) {
    where.type = type;
  }
  return sumTransactions('hostFeeInHostCurrency', where, hostCurrency);
}

export function getTotalNetAmount(
  collectiveids,
  type,
  startDate = new Date('2015-01-01'),
  endDate = new Date(),
  hostCurrency = 'USD',
) {
  const where = {
    CollectiveId: { [Op.in]: collectiveids },
    createdAt: { [Op.gte]: startDate, [Op.lt]: endDate },
  };
  if (type) {
    where.type = type;
  }
  return sumTransactions('netAmountInCollectiveCurrency', where, hostCurrency);
}
