import { GraphQLBoolean, GraphQLInt, GraphQLObjectType } from 'graphql';
import { get } from 'lodash';

import POLICIES from '../../../constants/policies';
import { VirtualCardLimitIntervals } from '../../../constants/virtual-cards';
import { getPolicy } from '../../../lib/policies';
import { checkScope } from '../../common/scope-check';
import { PolicyApplication } from '../enum/PolicyApplication';

import { Amount } from './Amount';

export const Policies = new GraphQLObjectType({
  name: 'Policies',
  fields: () => ({
    [POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE]: {
      type: GraphQLBoolean,
      resolve(account, req) {
        if (req.remoteUser?.isAdminOfCollective(account) && checkScope(req, 'account')) {
          return getPolicy(account, POLICIES.EXPENSE_AUTHOR_CANNOT_APPROVE);
        }
      },
    },
    [POLICIES.COLLECTIVE_MINIMUM_ADMINS]: {
      type: new GraphQLObjectType({
        name: POLICIES.COLLECTIVE_MINIMUM_ADMINS,
        fields: () => ({
          numberOfAdmins: { type: GraphQLInt },
          applies: { type: PolicyApplication },
          freeze: { type: GraphQLBoolean },
        }),
      }),
      resolve(account) {
        return getPolicy(account, POLICIES.COLLECTIVE_MINIMUM_ADMINS);
      },
    },
    [POLICIES.MAXIMUM_VIRTUAL_CARD_LIMIT_AMOUNT_FOR_INTERVAL]: {
      name: POLICIES.MAXIMUM_VIRTUAL_CARD_LIMIT_AMOUNT_FOR_INTERVAL,
      type: new GraphQLObjectType({
        name: POLICIES.MAXIMUM_VIRTUAL_CARD_LIMIT_AMOUNT_FOR_INTERVAL,
        fields: () => ({
          [VirtualCardLimitIntervals.ALL_TIME]: { type: Amount },
          [VirtualCardLimitIntervals.DAILY]: { type: Amount },
          [VirtualCardLimitIntervals.MONTHLY]: { type: Amount },
          [VirtualCardLimitIntervals.PER_AUTHORIZATION]: { type: Amount },
          [VirtualCardLimitIntervals.WEEKLY]: { type: Amount },
          [VirtualCardLimitIntervals.YEARLY]: { type: Amount },
        }),
      }),
      resolve(account) {
        if (get(account.settings, 'features.virtualCards')) {
          const policy = getPolicy(account, POLICIES.MAXIMUM_VIRTUAL_CARD_LIMIT_AMOUNT_FOR_INTERVAL);
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
