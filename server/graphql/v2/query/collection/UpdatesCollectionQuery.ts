import { GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { Order } from 'sequelize';

import models, { Op } from '../../../../models/index.js';
import { GraphQLUpdateCollection } from '../../collection/UpdateCollection.js';
import { AccountTypeToModelMapping, GraphQLAccountType } from '../../enum/index.js';
import { fetchAccountsIdsWithReference, GraphQLAccountReferenceInput } from '../../input/AccountReferenceInput.js';
import { CollectionArgs, CollectionReturnType } from '../../interface/Collection.js';

const UpdatesCollectionQuery = {
  type: new GraphQLNonNull(GraphQLUpdateCollection),
  args: {
    ...CollectionArgs,
    accountTag: {
      type: new GraphQLList(GraphQLString),
      description: 'Only return updates from accounts that have one of these tags',
    },
    accountType: {
      type: new GraphQLList(GraphQLAccountType),
      description:
        'Only return updates from accounts that match these types (COLLECTIVE, FUND, EVENT, PROJECT, ORGANIZATION or INDIVIDUAL)',
    },
    host: {
      type: new GraphQLList(GraphQLAccountReferenceInput),
      description: 'Host for the accounts for which to get updates',
    },
  },
  async resolve(_: void, args): Promise<CollectionReturnType> {
    const { offset, limit } = args;
    const where = {
      // Only return published updates
      publishedAt: { [Op.ne]: null },
      // Only return updates that are public
      isPrivate: false,
    };
    let include;

    if (args.host || args.accountTag || args.accountType?.length) {
      include = {
        model: models.Collective,
        as: 'collective',
        required: true,
        where: {},
      };
      if (args.host) {
        const hostCollectiveIds = await fetchAccountsIdsWithReference(args.host);
        include.where = { ...include.where, HostCollectiveId: hostCollectiveIds };
      }
      if (args.accountTag) {
        include.where = { ...include.where, tags: { [Op.overlap]: args.accountTag } };
      }
      if (args.accountType?.length) {
        include.where = { ...include.where, type: args.accountType.map(value => AccountTypeToModelMapping[value]) };
      }
    }

    const order: Order = [['publishedAt', 'DESC']];
    const result = await models.Update.findAndCountAll({ where, order, offset, limit, include });
    return { nodes: result.rows, totalCount: result.count, limit, offset };
  },
};

export default UpdatesCollectionQuery;
