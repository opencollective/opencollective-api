import { GraphQLList, GraphQLNonNull } from 'graphql';
import { isEmpty } from 'lodash';
import { Order } from 'sequelize';

import models from '../../../../models';
import { checkRemoteUserCanUseVirtualCards } from '../../../common/scope-check';
import { Forbidden } from '../../../errors';
import { GraphQLVirtualCardRequestCollection } from '../../collection/VirtualCardRequestCollection';
import { GraphQLVirtualCardRequestStatus } from '../../enum/VirtualCardRequestStatus';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../../input/AccountReferenceInput';
import { CollectionArgs, CollectionReturnType, getValidatedPaginationArgs } from '../../interface/Collection';

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
    checkRemoteUserCanUseVirtualCards(req);
    const { offset, limit } = getValidatedPaginationArgs(args, req);

    const host = await fetchAccountWithReference(args.host, { throwIfMissing: true });
    const isHostAdmin = req.remoteUser.isAdminOfCollective(host);
    const where = {
      HostCollectiveId: host.id,
    };

    if (!isEmpty(args.collective)) {
      const collectives = await Promise.all(
        args.collective.map(collectiveReference =>
          fetchAccountWithReference(collectiveReference, { throwIfMissing: true, loaders: req.loaders }),
        ),
      );

      for (const collective of collectives) {
        if (collective.HostCollectiveId !== host.id) {
          throw new Forbidden(`One of the requested collectives is not hosted by ${host.name}.`);
        } else if (!isHostAdmin && !req.remoteUser.isAdminOfCollective(collective)) {
          throw new Forbidden('You are not authorized to view virtual card requests for this collective.');
        }
      }

      where['CollectiveId'] = collectives.map(collective => collective.id);
    } else if (!isHostAdmin) {
      throw new Forbidden('You are not authorized to view virtual card requests for this host.');
    }

    if (!isEmpty(args.status)) {
      where['status'] = args.status;
    }

    const order: Order = [['createdAt', 'DESC']];
    const result = await models.VirtualCardRequest.findAndCountAll({
      where,
      order,
      offset,
      limit,
    });
    return { nodes: result.rows, totalCount: result.count, limit, offset };
  },
};

export default VirtualCardRequestsCollectionQuery;
