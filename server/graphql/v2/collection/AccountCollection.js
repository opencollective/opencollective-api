import { GraphQLBoolean, GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';
import moment from 'moment';
import { Op } from 'sequelize';

import models from '../../../models';
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
          includeChildren: { type: GraphQLBoolean, defaultValue: false },
        },
        description: 'Stats for the returned results (i.e. accounts within the limit)',
        async resolve(collection, args) {
          const collectiveIds = collection.nodes.map(c => c.id);

          if (args.includeChildren) {
            const childCollectives = await models.Collective.findAll({
              attributes: ['id'],
              where: { ParentCollectiveId: { [Op.in]: collectiveIds } },
            });
            collectiveIds.push(...childCollectives.map(c => c.id));
          }
          return { collectiveIds };
        },
      },
    };
  },
});

export { AccountCollection };
