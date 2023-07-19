import { GraphQLList, GraphQLNonNull } from 'graphql';
import { GraphQLBoolean } from 'graphql/type/index.mjs';
import { GraphQLDateTime } from 'graphql-scalars';
import { flatten, uniq } from 'lodash-es';
import { Order } from 'sequelize';

import ActivityTypes, { ActivitiesPerClass } from '../../../../constants/activities.js';
import models, { Op } from '../../../../models/index.js';
import { checkRemoteUserCanUseAccount } from '../../../common/scope-check.js';
import { GraphQLActivityCollection } from '../../collection/ActivityCollection.js';
import { GraphQLActivityAndClassesType } from '../../enum/ActivityType.js';
import { fetchAccountsWithReferences, GraphQLAccountReferenceInput } from '../../input/AccountReferenceInput.js';
import { CollectionArgs, CollectionReturnType } from '../../interface/Collection.js';

const IGNORED_ACTIVITIES: string[] = [ActivityTypes.COLLECTIVE_TRANSACTION_CREATED]; // This activity is creating a lot of noise, is usually covered already by orders/expenses activities and is not properly categorized (see https://github.com/opencollective/opencollective/issues/5903)

const ActivitiesCollectionArgs = {
  limit: { ...CollectionArgs.limit, defaultValue: 100 },
  offset: CollectionArgs.offset,
  account: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLAccountReferenceInput))),
    description: 'The accounts associated with the Activity',
  },
  includeChildrenAccounts: {
    type: new GraphQLNonNull(GraphQLBoolean),
    defaultValue: false,
    description: 'If account is a parent, also include child accounts',
  },
  excludeParentAccount: {
    type: new GraphQLNonNull(GraphQLBoolean),
    defaultValue: false,
    description:
      'If account is a parent, use this option to exclude it from the results. Use in combination with includeChildrenAccounts.',
  },
  includeHostedAccounts: {
    type: new GraphQLNonNull(GraphQLBoolean),
    defaultValue: false,
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
    type: new GraphQLList(new GraphQLNonNull(GraphQLActivityAndClassesType)),
    defaultValue: null,
    description: 'Only return activities that are of this class/type',
  },
  timeline: {
    type: new GraphQLNonNull(GraphQLBoolean),
    defaultValue: false,
    description: 'If true, return the timeline of activities for this account',
  },
};

const ActivitiesCollectionQuery = {
  type: new GraphQLNonNull(GraphQLActivityCollection),
  args: ActivitiesCollectionArgs,
  async resolve(_: void, args, req): Promise<CollectionReturnType> {
    const { offset, limit } = args;
    if (!args.account.length) {
      throw new Error('Please provide at least one account');
    }

    const accounts = await fetchAccountsWithReferences(args.account, { throwIfMissing: true });

    // Sanity checks for performance
    if (args.includeHostedAccounts && accounts.length > 1) {
      throw new Error('Cannot retrieve hosted accounts activity for multiple hosts at the same time');
    } else if (args.includeChildrenAccounts && accounts.length > 100) {
      throw new Error('Cannot retrieve children accounts activity for more than 100 accounts at the same time');
    }

    // Check permissions
    checkRemoteUserCanUseAccount(req);
    const isRoot = req.remoteUser.isRoot();

    // Build accounts conditions
    const accountOrConditions = [];
    const allowedAccounts = isRoot ? accounts : accounts.filter(a => req.remoteUser.isAdminOfCollectiveOrHost(a));
    for (const account of allowedAccounts) {
      // Include all activities related to the account itself
      if (!args.excludeParentAccount) {
        accountOrConditions.push({ CollectiveId: account.id }, { FromCollectiveId: account.id });
      }

      // Include all activities related to the account's hosted collectives
      if (args.includeHostedAccounts && account.isHostAccount) {
        accountOrConditions.push({ HostCollectiveId: account.id });
      }
    }

    // Include all activities related to the account's children
    if (args.includeChildrenAccounts) {
      const parentIds = uniq(allowedAccounts.map(account => account.id));
      const childrenAccounts = await models.Collective.findAll({
        attributes: ['id'],
        where: { ParentCollectiveId: parentIds, id: { [Op.notIn]: parentIds } },
        raw: true,
      });

      childrenAccounts.forEach(childAccount => {
        accountOrConditions.push({ CollectiveId: childAccount.id }, { FromCollectiveId: childAccount.id });
      });
    }

    if (accountOrConditions.length === 0) {
      return { nodes: null, totalCount: 0, limit, offset };
    }

    const where = { [Op.or]: accountOrConditions };
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
    const result = await models.Activity.findAll({ where, order, offset, limit });
    return {
      nodes: result,
      totalCount: () => models.Activity.count({ where }),
      limit: args.limit,
      offset: args.offset,
    };
  },
};

export default ActivitiesCollectionQuery;
