import { GraphQLNonNull } from 'graphql';

import models from '../../../../models';
import { ActivityCollection } from '../../collection/ActivityCollection';
import { AccountReferenceInput, fetchAccountWithReference } from '../../input/AccountReferenceInput';
import { CollectionArgs } from '../../interface/Collection';

const ActivitiesCollectionArgs = {
  limit: { ...CollectionArgs.limit, defaultValue: 100 },
  offset: CollectionArgs.offset,
  account: {
    type: AccountReferenceInput,
    description: 'The account associated with the Activity',
  },
};

const ActivitiesCollectionQuery = {
  type: new GraphQLNonNull(ActivityCollection),
  args: ActivitiesCollectionArgs,
  async resolve(_: void, args): Promise<any> {
    const { offset, limit } = args;
    const account = args.account && (await fetchAccountWithReference(args.account));
    const where = {};
    if (account?.id) {
      where['CollectiveId'] = account.id;
    }
    const result = await models.Activity.findAndCountAll({ where, offset, limit });
    return {
      nodes: result.rows,
      totalCount: result.count,
      limit: args.limit,
      offset: args.offset,
    };
  },
};

export default ActivitiesCollectionQuery;
