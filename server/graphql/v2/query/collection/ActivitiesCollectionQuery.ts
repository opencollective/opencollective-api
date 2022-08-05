import { GraphQLNonNull } from 'graphql';
import { Order } from 'sequelize';

import models from '../../../../models';
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
