import { GraphQLNonNull } from 'graphql';
import { Order } from 'sequelize';

import models from '../../../../models';
import { checkRemoteUserCanUseExportRequests } from '../../../common/scope-check';
import { Forbidden } from '../../../errors';
import { GraphQLExportRequestCollection } from '../../collection/ExportRequestCollection';
import { GraphQLExportRequestStatus } from '../../enum/ExportRequestStatus';
import { GraphQLExportRequestType } from '../../enum/ExportRequestType';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../../input/AccountReferenceInput';
import { CollectionArgs, CollectionReturnType } from '../../interface/Collection';

const ExportRequestsCollectionQuery = {
  type: new GraphQLNonNull(GraphQLExportRequestCollection),
  args: {
    ...CollectionArgs,
    account: {
      type: new GraphQLNonNull(GraphQLAccountReferenceInput),
      description: 'The account to get export requests for',
    },
    type: {
      type: GraphQLExportRequestType,
      description: 'Filter by export request type',
    },
    status: {
      type: GraphQLExportRequestStatus,
      description: 'Filter by export request status',
    },
  },
  async resolve(_: void, args, req: Express.Request): Promise<CollectionReturnType> {
    checkRemoteUserCanUseExportRequests(req);

    // Fetch account and check permissions
    const account = await fetchAccountWithReference(args.account, { throwIfMissing: true });
    if (!req.remoteUser.isAdminOfCollective(account)) {
      throw new Forbidden('You do not have permission to view export requests for this account');
    }

    // Build query conditions
    const where: Record<string, unknown> = {
      CollectiveId: account.id,
    };

    if (args.type) {
      where.type = args.type;
    }

    if (args.status) {
      where.status = args.status;
    }

    const order: Order = [['createdAt', 'DESC']];
    const { offset, limit } = args;

    const result = await models.ExportRequest.findAndCountAll({
      where,
      order,
      offset,
      limit,
    });

    return {
      nodes: result.rows,
      totalCount: result.count,
      limit,
      offset,
    };
  },
};

export default ExportRequestsCollectionQuery;
