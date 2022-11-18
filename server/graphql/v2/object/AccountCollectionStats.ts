import { GraphQLBoolean, GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';
import moment from 'moment';
import { Op } from 'sequelize';

import queries from '../../../lib/queries';
import models from '../../../models';
import { TransactionKind } from '../enum/TransactionKind';
import { TransactionType } from '../enum/TransactionType';
import { getNumberOfDays, getTimeUnit, TimeSeriesArgs } from '../object/TimeSeriesAmount';
import { TimeSeriesAmountWithCount } from '../object/TimeSeriesAmountWithCount';

export const resultsToAmountWithCountNode = results => {
  return results.map(result => ({
    date: result.date,
    count: result.count,
    amount: { value: result.amount, currency: result.currency },
  }));
};

export const AccountCollectionStats = new GraphQLObjectType({
  name: 'AccountCollectionStats',
  description: 'Account collection stats',
  fields: () => ({
    transactionsTimeSeries: {
      type: new GraphQLNonNull(TimeSeriesAmountWithCount),
      args: {
        ...TimeSeriesArgs,
        kind: {
          type: new GraphQLList(TransactionKind),
          description: 'To filter by transaction kind',
        },
        type: {
          type: TransactionType,
          description: 'The transaction type (DEBIT or CREDIT)',
        },
        includeChildren: { type: GraphQLBoolean, defaultValue: false },
      },
      description: 'Time series of the transaction count and sum of amount for these accounts',
      resolve: async (collection, args) => {
        const collectiveIds = collection.nodes.map(c => c.id);

        if (args.includeChildren) {
          const childCollectives = await models.Collective.findAll({
            attributes: ['id'],
            where: { ParentCollectiveId: { [Op.in]: collectiveIds } },
          });
          collectiveIds.push(...childCollectives.map(c => c.id));
        }

        const dateFrom = args.dateFrom ? moment(args.dateFrom) : null;
        const dateTo = args.dateTo ? moment(args.dateTo) : null;
        const timeUnit = args.timeUnit || getTimeUnit(getNumberOfDays(dateFrom, dateTo, {}) || 1);

        const transactionParams = { type: args.type, kind: args.kind, dateFrom, dateTo, collectiveIds };
        const amountDataPoints = collectiveIds.length
          ? await queries.getTransactionsTimeSeries(timeUnit, transactionParams)
          : [];
        return { dateFrom, dateTo, timeUnit, nodes: resultsToAmountWithCountNode(amountDataPoints) };
      },
    },
  }),
});
