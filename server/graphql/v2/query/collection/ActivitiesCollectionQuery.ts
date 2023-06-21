import { GraphQLList, GraphQLNonNull } from 'graphql';
import { GraphQLBoolean } from 'graphql/type';
import { GraphQLDateTime } from 'graphql-scalars';
import { flatten, toString, uniq } from 'lodash';
import { InferAttributes, Order, WhereOptions } from 'sequelize';

import ActivityTypes, { ActivitiesPerClass } from '../../../../constants/activities';
import { types as AccountTypes } from '../../../../constants/collectives';
import MemberRoles from '../../../../constants/roles';
import models, { Op } from '../../../../models';
import { Activity } from '../../../../models/Activity';
import { MemberModelInterface } from '../../../../models/Member';
import { checkRemoteUserCanUseAccount } from '../../../common/scope-check';
import { BadRequest, Unauthorized } from '../../../errors';
import { GraphQLActivityCollection } from '../../collection/ActivityCollection';
import { GraphQLActivityAndClassesType } from '../../enum/ActivityType';
import { fetchAccountsWithReferences, GraphQLAccountReferenceInput } from '../../input/AccountReferenceInput';
import { CollectionArgs, CollectionReturnType } from '../../interface/Collection';

const IGNORED_ACTIVITIES: string[] = [ActivityTypes.COLLECTIVE_TRANSACTION_CREATED]; // This activity is creating a lot of noise, is usually covered already by orders/expenses activities and is not properly categorized (see https://github.com/opencollective/opencollective/issues/5903)

const getCollectiveIdsForRole = (memberships: MemberModelInterface[], roles: MemberRoles[]): number[] =>
  memberships.filter(m => roles.includes(m.role)).map(m => m.CollectiveId);

const generateTimelineQuery = async (account): Promise<WhereOptions<InferAttributes<Activity, { omit: never }>>> => {
  if (account.type === AccountTypes.USER) {
    const user = await account.getUser();
    const memberships = await user.getMemberships();
    return {
      [Op.or]: [
        // Events on expenses the user submitted but omitting my own actions
        {
          type: {
            [Op.in]: [
              ActivityTypes.COLLECTIVE_EXPENSE_APPROVED,
              ActivityTypes.COLLECTIVE_EXPENSE_ERROR,
              ActivityTypes.COLLECTIVE_EXPENSE_MARKED_AS_INCOMPLETE,
              ActivityTypes.COLLECTIVE_EXPENSE_PAID,
              ActivityTypes.COLLECTIVE_EXPENSE_REJECTED,
              ActivityTypes.COLLECTIVE_EXPENSE_UNAPPROVED,
              ActivityTypes.COLLECTIVE_EXPENSE_UPDATED,
              ActivityTypes.EXPENSE_COMMENT_CREATED,
            ],
          },
          data: { user: { id: toString(account.id) } },
          UserId: { [Op.ne]: account.CreatedByUserId },
        },
        // Expenses that were drafted for me (recurring expenses waiting to be submitted)
        {
          type: ActivityTypes.COLLECTIVE_EXPENSE_INVITE_DRAFTED,
          data: { payee: { id: toString(account.id) } },
        },
        { type: ActivityTypes.COLLECTIVE_EXPENSE_RECURRING_DRAFTED, UserId: user.id },
        // My contributions, both one-time and when recurring contributions are drawn
        //  Update your payment method
        //  There is an issue with your credit card, etc
        {
          type: {
            [Op.in]: [
              ActivityTypes.PAYMENT_FAILED,
              ActivityTypes.ORDER_PAYMENT_FAILED,
              ActivityTypes.ORDER_THANKYOU,
              ActivityTypes.ORDER_PROCESSING,
            ],
          },
          [Op.or]: [{ UserId: account.CreatedByUserId }, { FromCollectiveId: account.id }],
        },
        // Updates from Collectives I contribute to
        {
          type: ActivityTypes.COLLECTIVE_UPDATE_PUBLISHED,
          CollectiveId: {
            [Op.in]: getCollectiveIdsForRole(memberships, [
              MemberRoles.BACKER,
              MemberRoles.FOLLOWER,
              MemberRoles.MEMBER,
              MemberRoles.CONTRIBUTOR,
              MemberRoles.ATTENDEE,
              MemberRoles.ADMIN,
            ]),
          },
        },
        // Purchases made with Virtual Cards assigned to me
        //  Missing receipts
        //  Errors, etc
        {
          type: {
            [Op.in]: [
              ActivityTypes.COLLECTIVE_VIRTUAL_CARD_MISSING_RECEIPTS,
              ActivityTypes.COLLECTIVE_VIRTUAL_CARD_SUSPENDED,
              ActivityTypes.VIRTUAL_CARD_PURCHASE,
            ],
          },
          UserId: user.id,
        },
      ],
    };
  } else {
    return { [Op.or]: [{ CollectiveId: account.id }, { FromCollectiveId: account.id }] };
  }
};

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

    let where;
    if (args.timeline) {
      if (accounts.length !== 1) {
        throw new BadRequest('Cannot retrieve timeline for multiple accounts at the same time');
      }
      if (!req.remoteUser?.isAdminOfCollective(accounts[0]) && !isRoot) {
        throw new Unauthorized('You need to be logged in as an admin of this collective to see its activity');
      }
      where = await generateTimelineQuery(accounts[0]);
    } else {
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

      where = { [Op.or]: accountOrConditions };
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
