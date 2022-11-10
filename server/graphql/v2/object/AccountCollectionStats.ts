import { GraphQLNonNull, GraphQLObjectType } from 'graphql';

import { TransactionKind } from '../../../constants/transaction-kind';
import { TransactionTypes } from '../../../constants/transactions';
import sequelize from '../../../lib/sequelize';
import { computeDatesAsISOStrings } from '../../../lib/utils';
import { getTimeSeriesFields } from '../interface/TimeSeries';
import { resultsToAmountNode } from '../object/HostMetricsTimeSeries';
import { TimeSeriesAmount } from '../object/TimeSeriesAmount';
import { TimeSeriesCount } from '../object/TimeSeriesCount';

const resultsToCountNode = results => {
  return results.map(result => ({
    date: result.date,
    count: result.count,
  }));
};

export const AccountCollectionStats = new GraphQLObjectType({
  name: 'AccountCollectionStats',
  description: 'Account collection stats',
  fields: () => ({
    ...getTimeSeriesFields(),
    contributionsCountTimeSeries: {
      type: new GraphQLNonNull(TimeSeriesCount),
      description: 'Time series of the number of contributions to these accounts',
      resolve: async ({ collectiveIds, dateFrom, dateTo, timeUnit }) => {
        const kind = [TransactionKind.CONTRIBUTION];
        const transactionParams = { type: TransactionTypes.CREDIT, kind, dateFrom, dateTo, collectiveIds };
        const amountDataPoints = await getTransactionsCountTimeSeries(timeUnit, transactionParams);
        return { dateFrom, dateTo, timeUnit, nodes: resultsToCountNode(amountDataPoints) };
      },
    },
    totalReceivedTimeSeries: {
      type: new GraphQLNonNull(TimeSeriesAmount),
      description: 'Time series of the total money received by these accounts',
      resolve: async ({ collectiveIds, dateFrom, dateTo, timeUnit }) => {
        const kind = [TransactionKind.CONTRIBUTION, TransactionKind.ADDED_FUNDS];
        const transactionParams = { type: TransactionTypes.CREDIT, kind, dateFrom, dateTo, collectiveIds };
        const amountDataPoints = await getTransactionsTimeSeries(timeUnit, transactionParams);
        return { dateFrom, dateTo, timeUnit, nodes: resultsToAmountNode(amountDataPoints) };
      },
    },
  }),
});

const getTransactionsTimeSeries = async (
  timeUnit,
  { type = null, kind = null, collectiveIds = [], dateFrom = null, dateTo = null } = {},
) => {
  return sequelize.query(
    `SELECT DATE_TRUNC(:timeUnit, "createdAt") AS "date", sum("amountInHostCurrency") as "amount", "hostCurrency" as "currency"
         FROM "Transactions"
         WHERE "deletedAt" IS NULL
           AND "CollectiveId" IN (:collectiveIds)
           ${type ? `AND "type" = :type` : ``}
           ${kind?.length ? `AND "kind" IN (:kind)` : ``}
           ${dateFrom ? `AND "createdAt" >= :startDate` : ``}
           ${dateTo ? `AND "createdAt" <= :endDate` : ``}
         GROUP BY DATE_TRUNC(:timeUnit, "createdAt"), "hostCurrency"
         ORDER BY DATE_TRUNC(:timeUnit, "createdAt")
        `,
    {
      type: sequelize.QueryTypes.SELECT,
      replacements: {
        kind: Array.isArray(kind) ? kind : [kind],
        type,
        timeUnit,
        collectiveIds,
        ...computeDatesAsISOStrings(dateFrom, dateTo),
      },
    },
  );
};

const getTransactionsCountTimeSeries = async (
  timeUnit,
  { type = null, kind = null, collectiveIds = [], dateFrom = null, dateTo = null } = {},
) => {
  return sequelize.query(
    `SELECT DATE_TRUNC(:timeUnit, "createdAt") AS "date", count("id") as "count"
         FROM "Transactions"
         WHERE "deletedAt" IS NULL
           AND "CollectiveId" IN (:collectiveIds)
           ${type ? `AND "type" = :type` : ``}
           ${kind?.length ? `AND "kind" IN (:kind)` : ``}
           ${dateFrom ? `AND "createdAt" >= :startDate` : ``}
           ${dateTo ? `AND "createdAt" <= :endDate` : ``}
         GROUP BY DATE_TRUNC(:timeUnit, "createdAt")
         ORDER BY DATE_TRUNC(:timeUnit, "createdAt")
        `,
    {
      type: sequelize.QueryTypes.SELECT,
      replacements: {
        kind: Array.isArray(kind) ? kind : [kind],
        type,
        timeUnit,
        collectiveIds,
        ...computeDatesAsISOStrings(dateFrom, dateTo),
      },
    },
  );
};
