import { GraphQLList, GraphQLNonNull } from 'graphql';
import { GraphQLBoolean } from 'graphql/type';
import { GraphQLDateTime } from 'graphql-scalars';
import { flatten, uniq } from 'lodash';
import { Order } from 'sequelize';

import ActivityTypes, { ActivitiesPerClass } from '../../../../constants/activities';
import models, { Op } from '../../../../models';
import { checkRemoteUserCanUseAccount } from '../../../common/scope-check';
import { ActivityCollection } from '../../collection/ActivityCollection';
import { ActivityAndClassesType } from '../../enum/ActivityType';
import { AccountReferenceInput, fetchAccountsWithReferences } from '../../input/AccountReferenceInput';
import { CollectionArgs, CollectionReturnType } from '../../interface/Collection';

const IGNORED_ACTIVITIES: string[] = [ActivityTypes.COLLECTIVE_TRANSACTION_CREATED]; // This activity is creating a lot of noise, is usually covered already by orders/expenses activities and is not properly categorized (see https://github.com/opencollective/opencollective/issues/5903)

const ActivitiesCollectionArgs = {
  limit: { ...CollectionArgs.limit, defaultValue: 100 },
  offset: CollectionArgs.offset,
  account: {
    type: new GraphQLList(new GraphQLNonNull(AccountReferenceInput)),
    description: 'The accounts associated with the Activity',
  },
  includeChildrenAccounts: {
    type: GraphQLBoolean,
    defaultValue: true,
    description: 'If account is a parent, also include child accounts',
  },
  includeHostedAccounts: {
    type: GraphQLBoolean,
    defaultValue: true,
    description: 'If account is a host, also include hosted accounts',
  },
  dateFrom: {
    type: GraphQLDateTime,
    defaultValue: null,
    description: 'Only return activities that were created after this date',
  },
  dateTo: {
    type: GraphQLDateTime,
    defaultValue: null,
    description: 'Only return activities that were created before this date',
  },
  type: {
    type: new GraphQLList(new GraphQLNonNull(ActivityAndClassesType)),
    defaultValue: null,
    description: 'Only return activities that are of this class/type',
  },
};

const ActivitiesCollectionQuery = {
  type: new GraphQLNonNull(ActivityCollection),
  args: ActivitiesCollectionArgs,
  async resolve(_: void, args, req): Promise<CollectionReturnType> {
    const { offset, limit } = args;
    let accounts;
    if (args.account) {
      accounts = await fetchAccountsWithReferences(args.account, { throwIfMissing: true });
    }

    // Check permissions
    checkRemoteUserCanUseAccount(req);
    const isRootUser = req.remoteUser.isRoot();
    const accountOrConditions = [];
    const where = { [Op.or]: accountOrConditions };
    for (const account of accounts) {
      if (isRootUser || req.remoteUser.isAdminOfCollective(account)) {
        accountOrConditions.push({ CollectiveId: account.id });
        if (args.includeChildrenAccounts) {
          const childIds = await account.getChildren().then(children => children.map(child => child.id));
          accountOrConditions.push(...childIds.map(id => ({ CollectiveId: id })));
        }
        if (args.includeHostedAccounts && account.isHostAccount) {
          const hostedAccounts = await account.getHostedCollectives({ attributes: ['id'] });
          accountOrConditions.push(...hostedAccounts.map(hostedAccount => ({ CollectiveId: hostedAccount.id })));
        }
      }
    }

    if (accountOrConditions.length === 0) {
      return { nodes: null, totalCount: 0, limit, offset };
    }

    if (args.dateFrom) {
      where['createdAt'] = { [Op.gte]: args.dateFrom };
    }
    if (args.dateTo) {
      where['createdAt'] = Object.assign({}, where['createdAt'], { [Op.lte]: args.dateTo });
    }
    if (args.type) {
      const selectedActivities: string[] = uniq(flatten(args.type.map(type => ActivitiesPerClass[type] || type)));
      where['type'] = selectedActivities.filter(type => !IGNORED_ACTIVITIES.includes(type));
    } else {
      where['type'] = { [Op.not]: IGNORED_ACTIVITIES };
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
