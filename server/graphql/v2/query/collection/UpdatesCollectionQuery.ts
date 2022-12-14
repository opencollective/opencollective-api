import { GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';

import models, { Op } from '../../../../models';
import { UpdatesCollection } from '../../collection/UpdatesCollection';
import { AccountReferenceInput, fetchAccountsIdsWithReference } from '../../input/AccountReferenceInput';
import { CollectionArgs, CollectionReturnType } from '../../interface/Collection';

const UpdatesCollectionQuery = {
  type: new GraphQLNonNull(UpdatesCollection),
  args: {
    ...CollectionArgs,
    tag: {
      type: new GraphQLList(GraphQLString),
      description: 'Only from accounts that have one of these tags',
    },
    host: {
      type: new GraphQLList(AccountReferenceInput),
      description: 'Host for the account for which to get updates',
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

    if (args.host || args.tag) {
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
      if (args.tag) {
        include.where = { ...include.where, tags: { [Op.overlap]: args.tag } };
      }
    }

    const order = [['publishedAt', 'DESC']];
    const result = await models.Update.findAndCountAll({ where, order, offset, limit, include });
    return { nodes: result.rows, totalCount: result.count, limit, offset };
  },
};

export default UpdatesCollectionQuery;
