import { GraphQLNonNull } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import { Order } from 'sequelize';

import models, { Op } from '../../../../models';
import { checkRemoteUserCanUseAccount } from '../../../common/scope-check';
import { ActivityCollection } from '../../collection/ActivityCollection';
import { AccountReferenceInput, fetchAccountWithReference } from '../../input/AccountReferenceInput';
import { CollectionArgs, CollectionReturnType } from '../../interface/Collection';

const ActivitiesCollectionArgs = {
  limit: { ...CollectionArgs.limit, defaultValue: 100 },
  offset: CollectionArgs.offset,
  account: {
    type: new GraphQLNonNull(AccountReferenceInput),
    description: 'The account associated with the Activity',
  },
  dateFrom: {
    type: GraphQLDateTime,
    defaultValue: null,
    description: 'Only return expenses that were created after this date',
  },
  dateTo: {
    type: GraphQLDateTime,
    defaultValue: null,
    description: 'Only return expenses that were created before this date',
  },
};

const ActivitiesCollectionQuery = {
  type: new GraphQLNonNull(ActivityCollection),
  args: ActivitiesCollectionArgs,
  async resolve(_: void, args, req): Promise<CollectionReturnType> {
    const { offset, limit } = args;
    const account = await fetchAccountWithReference(args.account, { throwIfMissing: true });

    // Check permissions
    checkRemoteUserCanUseAccount(req);
    if (!req.remoteUser.isAdminOfCollective(account)) {
      return { nodes: null, totalCount: 0, limit, offset };
    }

    const where = { CollectiveId: account.id };

    if (args.dateFrom) {
      where['createdAt'] = { [Op.gte]: args.dateFrom };
    }
    if (args.dateTo) {
      where['createdAt'] = Object.assign({}, where['createdAt'], { [Op.lte]: args.dateTo });
    }

    const order: Order = [['createdAt', 'DESC']];
    const result = await models.Activity.findAndCountAll({ where, order, offset, limit });
    return {
      nodes: result.rows,
      totalCount: result.count,
      limit: args.limit,
      offset: args.offset,
    };
  },
};

export default ActivitiesCollectionQuery;
