import { GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';

import models, { Op } from '../../../../models';
import { UpdatesCollection } from '../../collection/UpdatesCollection';
import { AccountType, AccountTypeToModelMapping } from '../../enum';
import { AccountReferenceInput, fetchAccountsIdsWithReference } from '../../input/AccountReferenceInput';
import { CollectionArgs, CollectionReturnType } from '../../interface/Collection';

const UpdatesCollectionQuery = {
  type: new GraphQLNonNull(UpdatesCollection),
  args: {
    ...CollectionArgs,
    accountTag: {
      type: new GraphQLList(GraphQLString),
      description: 'Only return updates from accounts that have one of these tags',
    },
    accountType: {
      type: new GraphQLList(AccountType),
      description:
        'Only return updates from accounts that match these types (COLLECTIVE, FUND, EVENT, PROJECT, ORGANIZATION or INDIVIDUAL)',
    },
    host: {
      type: new GraphQLList(AccountReferenceInput),
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

    const order = [['publishedAt', 'DESC']];
    const result = await models.Update.findAndCountAll({ where, order, offset, limit, include });
    return { nodes: result.rows, totalCount: result.count, limit, offset };
  },
};

export default UpdatesCollectionQuery;
