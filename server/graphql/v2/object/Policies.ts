import { GraphQLBoolean, GraphQLInt, GraphQLObjectType, GraphQLString } from 'graphql';
import { get } from 'lodash';

import POLICIES from '../../../constants/policies';
import { VirtualCardLimitIntervals } from '../../../constants/virtual-cards';
import { getPolicy } from '../../../lib/policies';
import { checkScope } from '../../common/scope-check';
import { GraphQLPolicyApplication } from '../enum/PolicyApplication';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';

import { GraphQLAmount } from './Amount';

export const GraphQLPolicies = new GraphQLObjectType({
  name: 'Policies',
  fields: () => ({
    id: {
      type: GraphQLString,
      resolve: getIdEncodeResolver(IDENTIFIER_TYPES.ACCOUNT),
    },
    [POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE]: {
      type: new GraphQLObjectType({
        name: POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE,
        fields: () => ({
          amountInCents: { type: GraphQLInt },
          enabled: { type: GraphQLBoolean },
          appliesToHostedCollectives: { type: GraphQLBoolean },
          appliesToSingleAdminCollectives: { type: GraphQLBoolean },
        }),
      }),
      async resolve(account, _, req) {
        if (req.remoteUser?.isAdminOfCollective(account) && checkScope(req, 'account')) {
          return await getPolicy(account, POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE);
        }
      },
    },
    [POLICIES.REQUIRE_2FA_FOR_ADMINS]: {
      type: GraphQLBoolean,
      async resolve(account, _, req) {
        if (req.remoteUser?.isAdminOfCollective(account) && checkScope(req, 'account')) {
          return await getPolicy(account, POLICIES.REQUIRE_2FA_FOR_ADMINS);
        }
      },
    },
    [POLICIES.COLLECTIVE_ADMINS_CAN_REFUND]: {
      type: GraphQLBoolean,
      async resolve(account, _, req) {
        if (req.remoteUser?.isAdminOfCollectiveOrHost(account) && checkScope(req, 'account')) {
          return await getPolicy(account, POLICIES.COLLECTIVE_ADMINS_CAN_REFUND);
        }
      },
    },
    [POLICIES.COLLECTIVE_MINIMUM_ADMINS]: {
      type: new GraphQLObjectType({
        name: POLICIES.COLLECTIVE_MINIMUM_ADMINS,
        fields: () => ({
          numberOfAdmins: { type: GraphQLInt },
          applies: { type: GraphQLPolicyApplication },
          freeze: { type: GraphQLBoolean },
        }),
      }),
      async resolve(account) {
        return await getPolicy(account, POLICIES.COLLECTIVE_MINIMUM_ADMINS);
      },
    },
    [POLICIES.MAXIMUM_VIRTUAL_CARD_LIMIT_AMOUNT_FOR_INTERVAL]: {
      name: POLICIES.MAXIMUM_VIRTUAL_CARD_LIMIT_AMOUNT_FOR_INTERVAL,
      type: new GraphQLObjectType({
        name: POLICIES.MAXIMUM_VIRTUAL_CARD_LIMIT_AMOUNT_FOR_INTERVAL,
        fields: () => ({
          [VirtualCardLimitIntervals.ALL_TIME]: { type: GraphQLAmount },
          [VirtualCardLimitIntervals.DAILY]: { type: GraphQLAmount },
          [VirtualCardLimitIntervals.MONTHLY]: { type: GraphQLAmount },
          [VirtualCardLimitIntervals.PER_AUTHORIZATION]: { type: GraphQLAmount },
          [VirtualCardLimitIntervals.WEEKLY]: { type: GraphQLAmount },
          [VirtualCardLimitIntervals.YEARLY]: { type: GraphQLAmount },
        }),
      }),
      async resolve(account) {
        if (get(account.settings, 'features.virtualCards')) {
          const policy = await getPolicy(account, POLICIES.MAXIMUM_VIRTUAL_CARD_LIMIT_AMOUNT_FOR_INTERVAL);
          return Object.keys(policy).reduce(
            (acc, policyKey: string) => ({
              ...acc,
              [policyKey]: {
                value: policy[policyKey],
                currency: account.currency,
              },
            }),
            {},
          );
        }
      },
    },
  }),
});
