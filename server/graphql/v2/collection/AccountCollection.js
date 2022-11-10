import { GraphQLBoolean, GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';
import moment from 'moment';

import { Account } from '../interface/Account';
import { Collection, CollectionFields } from '../interface/Collection';
import { AccountCollectionStats } from '../object/AccountCollectionStats';
import { getNumberOfDays, getTimeUnit, TimeSeriesArgs } from '../object/TimeSeriesAmount';

const AccountCollection = new GraphQLObjectType({
  name: 'AccountCollection',
  interfaces: [Collection],
  description: 'A collection of "Accounts"',
  fields: () => {
    return {
      ...CollectionFields,
      nodes: {
        type: new GraphQLList(Account),
      },
      stats: {
        type: new GraphQLNonNull(AccountCollectionStats),
        args: {
          ...TimeSeriesArgs,
          includeChildren: { type: GraphQLBoolean, defaultValue: false },
        },
        async resolve(collection, args) {
          const dateFrom = args.dateFrom ? moment(args.dateFrom) : null;
          const dateTo = args.dateTo ? moment(args.dateTo) : null;
          const timeUnit = args.timeUnit || getTimeUnit(getNumberOfDays(dateFrom, dateTo, {}) || 1);

          const collectiveIds = collection.nodes.map(c => c.id);

          if (args.includeChildren) {
            const childCollectiveIds = await Promise.all(
              collection.nodes.map(async c => await c.getChildren({ attributes: ['id'] })),
            );
            collectiveIds.push(...childCollectiveIds.flat().map(c => c.id));
          }

          return { timeUnit, dateFrom, dateTo, collectiveIds };
        },
      },
    };
  },
});

export { AccountCollection };
