import assert from 'assert';

import { GraphQLList, GraphQLNonNull } from 'graphql';
import { GraphQLBoolean } from 'graphql/type';
import { GraphQLDateTime } from 'graphql-scalars';
import { flatten, uniq } from 'lodash';
import { Order, WhereOptions } from 'sequelize';

import ActivityTypes, { ActivitiesPerClass } from '../../../../constants/activities';
import { CollectiveType } from '../../../../constants/collectives';
import models, { Activity, Collective, Op, User } from '../../../../models';
import { checkRemoteUserCanUseAccount } from '../../../common/scope-check';
import { BadRequest, NotFound } from '../../../errors';
import { GraphQLActivityCollection } from '../../collection/ActivityCollection';
import { GraphQLActivityAndClassesType } from '../../enum/ActivityType';
import {
  fetchAccountsWithReferences,
  fetchAccountWithReference,
  GraphQLAccountReferenceInput,
} from '../../input/AccountReferenceInput';
import {
  CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE,
  GraphQLChronologicalOrderInput,
} from '../../input/ChronologicalOrderInput';
import { CollectionArgs, CollectionReturnType, getValidatedPaginationArgs } from '../../interface/Collection';

const IGNORED_ACTIVITIES: string[] = [ActivityTypes.COLLECTIVE_TRANSACTION_CREATED]; // This activity is creating a lot of noise, is usually covered already by orders/expenses activities and is not properly categorized (see https://github.com/opencollective/opencollective/issues/5903)

const ActivitiesCollectionArgs = {
  limit: { ...CollectionArgs.limit, defaultValue: 100 },
  offset: CollectionArgs.offset,
  individual: {
    type: GraphQLAccountReferenceInput,
    description: 'The individual associated with the Activity',
  },
  account: {
    type: new GraphQLList(new GraphQLNonNull(GraphQLAccountReferenceInput)),
    description: 'The accounts associated with the Activity',
  },
  host: {
    type: GraphQLAccountReferenceInput,
    description: 'The hosts associated with the Activity',
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
  orderBy: {
    type: new GraphQLNonNull(GraphQLChronologicalOrderInput),
    defaultValue: CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE,
    description: 'Order of the results',
  },
};

const ActivitiesCollectionQuery = {
  type: new GraphQLNonNull(GraphQLActivityCollection),
  args: ActivitiesCollectionArgs,
  async resolve(_: void, args, req): Promise<CollectionReturnType> {
    checkRemoteUserCanUseAccount(req, { signedOutMessage: 'You need to be logged in to view activities.' });
    const isRoot = req.remoteUser.isRoot();
    const { offset, limit } = getValidatedPaginationArgs(args, req);

    // Load accounts
    let accounts: Collective[], user: User, host: Collective;
    if (args.account?.length) {
      accounts = await fetchAccountsWithReferences(args.account, { throwIfMissing: true });
    }
    if (args.host) {
      // No checking if still a host, as we may want to check activities on hosts that are not hosts anymore
      host = await fetchAccountWithReference(args.host, { throwIfMissing: true });
      if (!req.remoteUser.isAdminOfCollectiveOrHost(host)) {
        throw new Error('You are not allowed to access activities for this host');
      }
    }
    if (args.individual) {
      const individual = await fetchAccountWithReference(args.individual, { throwIfMissing: true });
      const isUserType = individual.type === CollectiveType.USER;
      assert(isUserType, new BadRequest(`Individual must be an individual, got ${individual.type}`));
      assert(Boolean(host), new BadRequest('Individual must be associated with a host'));
      user = await req.loaders.User.byCollectiveId.load(individual.id);
      assert(Boolean(user), new NotFound('User not found'));
    }

    if (!accounts?.length && (!user || !host)) {
      throw new Error('Please provide at least one account, individual or host');
    }

    // Build accounts conditions
    const where: WhereOptions<Activity> = {};
    const accountOrConditions = [];
    if (accounts?.length) {
      // Sanity checks for performance
      if (args.includeHostedAccounts && accounts.length > 1) {
        throw new Error('Cannot retrieve hosted accounts activity for multiple hosts at the same time');
      } else if (args.includeChildrenAccounts && accounts.length > 100) {
        throw new Error('Cannot retrieve children accounts activity for more than 100 accounts at the same time');
      }

      const allowedAccounts = isRoot ? accounts : accounts.filter(a => req.remoteUser.isAdminOfCollectiveOrHost(a));
      for (const account of allowedAccounts) {
        // Include all activities related to the account itself
        if (!args.excludeParentAccount) {
          accountOrConditions.push({ CollectiveId: account.id }, { FromCollectiveId: account.id });
        }

        // Include all activities related to the account's hosted collectives
        if (args.includeHostedAccounts && account.hasMoneyManagement) {
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
      } else {
        where[Op.or] = accountOrConditions;
      }
    }

    if (user) {
      where.UserId = user.id;
    }
    if (host) {
      where.HostCollectiveId = host.id;
    }
    if (args.dateFrom) {
      where.createdAt = { [Op.gte]: args.dateFrom };
    }
    if (args.dateTo) {
      where.createdAt = Object.assign({}, where['createdAt'], { [Op.lte]: args.dateTo });
    }
    if (args.type) {
      const selectedActivities: string[] = uniq(flatten(args.type.map(type => ActivitiesPerClass[type] || type)));
      where.type = selectedActivities.filter(type => !IGNORED_ACTIVITIES.includes(type));
    } else {
      where.type = { [Op.not]: IGNORED_ACTIVITIES };
    }

    const order: Order = [[args.orderBy.field, args.orderBy.direction]];
    if (order[0][0] !== 'createdAt') {
      throw new Error(`Ordering activities by ${order[0][0]} is not supported`);
    }

    return {
      nodes: () => models.Activity.findAll({ where, order, offset, limit }),
      totalCount: () => models.Activity.count({ where }),
      limit: args.limit,
      offset: args.offset,
    };
  },
};

export default ActivitiesCollectionQuery;
