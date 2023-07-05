import { GraphQLNonNull } from 'graphql';
import { Order } from 'sequelize';

import models from '../../../../models';
import { GraphQLVirtualCardRequestCollection } from '../../collection/VirtualCardRequestCollection';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../../input/AccountReferenceInput';
import { CollectionArgs, CollectionReturnType } from '../../interface/Collection';

const VirtualCardRequestsCollectionQuery = {
  type: new GraphQLNonNull(GraphQLVirtualCardRequestCollection),
  args: {
    ...CollectionArgs,
    host: {
      type: new GraphQLNonNull(GraphQLAccountReferenceInput),
      description: 'Host for the accounts for which to get virtual card requests',
    },
  },
  async resolve(_: void, args): Promise<CollectionReturnType> {
    const host = await fetchAccountWithReference(args.host, { throwIfMissing: true });

    const order: Order = [['createdAt', 'DESC']];
    const result = await models.VirtualCardRequest.findAndCountAll({
      where: {
        HostCollectiveId: host.id,
      },
      order,
      offset: args.offset,
      limit: args.limit,
    });
    return { nodes: result.rows, totalCount: result.count, limit: args.limit, offset: args.offset };
  },
};

export default VirtualCardRequestsCollectionQuery;
