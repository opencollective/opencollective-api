import { GraphQLList, GraphQLNonNull } from 'graphql';
import { isEmpty } from 'lodash';
import { Order } from 'sequelize';

import models from '../../../../models';
import { GraphQLVirtualCardRequestCollection } from '../../collection/VirtualCardRequestCollection';
import { GraphQLVirtualCardRequestStatus } from '../../enum/VirtualCardRequestStatus';
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
    status: { type: new GraphQLList(GraphQLVirtualCardRequestStatus) },
    collective: { type: new GraphQLList(GraphQLAccountReferenceInput) },
  },
  async resolve(_: void, args, req: Express.Request): Promise<CollectionReturnType> {
    const host = await fetchAccountWithReference(args.host, { throwIfMissing: true });

    const where = {
      HostCollectiveId: host.id,
    };

    if (!isEmpty(args.collective)) {
      where['CollectiveId'] = await Promise.all(
        args.collective.map(collectiveReference =>
          fetchAccountWithReference(collectiveReference, { throwIfMissing: true, loaders: req.loaders }),
        ),
      ).then(collectives => collectives.map(collective => collective.id));
    }

    if (!isEmpty(args.status)) {
      where['status'] = args.status;
    }

    const order: Order = [['createdAt', 'DESC']];
    const result = await models.VirtualCardRequest.findAndCountAll({
      where,
      order,
      offset: args.offset,
      limit: args.limit,
    });
    return { nodes: result.rows, totalCount: result.count, limit: args.limit, offset: args.offset };
  },
};

export default VirtualCardRequestsCollectionQuery;
