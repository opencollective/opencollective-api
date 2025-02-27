import { GraphQLBoolean, GraphQLInt, GraphQLObjectType, GraphQLString } from 'graphql';
import { get, isNil, mapValues } from 'lodash';

import POLICIES, { Policies } from '../../../constants/policies';
import { VirtualCardLimitIntervals } from '../../../constants/virtual-cards';
import { getFxRate } from '../../../lib/currency';
import { getPolicy } from '../../../lib/policies';
import { checkScope } from '../../common/scope-check';
import { GraphQLPolicyApplication } from '../enum/PolicyApplication';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';

import { GraphQLAmount } from './Amount';

const DEFAULT_CONTRIBUTION_INFO_USD_THRESHOLDS: Policies[POLICIES.CONTRIBUTOR_INFO_THRESHOLDS] = {
  address: 5000e2,
  legalName: 250e2,
};

export const GraphQLPolicies = new GraphQLObjectType({
  name: 'Policies',
  fields: () => ({
    id: {
      type: GraphQLString,
      resolve: getIdEncodeResolver(IDENTIFIER_TYPES.ACCOUNT),
    },
    [POLICIES.EXPENSE_POLICIES]: {
      type: new GraphQLObjectType({
        name: POLICIES.EXPENSE_POLICIES,
        fields: () => ({
          invoicePolicy: { type: GraphQLString },
          receiptPolicy: { type: GraphQLString },
          titlePolicy: { type: GraphQLString },
        }),
      }),
      async resolve(account) {
        return await getPolicy(account, POLICIES.EXPENSE_POLICIES);
      },
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
    [POLICIES.EXPENSE_CATEGORIZATION]: {
      name: POLICIES.EXPENSE_CATEGORIZATION,
      type: new GraphQLObjectType({
        name: POLICIES.EXPENSE_CATEGORIZATION,
        fields: () => ({
          requiredForExpenseSubmitters: { type: GraphQLBoolean },
          requiredForCollectiveAdmins: { type: GraphQLBoolean },
        }),
      }),
      async resolve(account) {
        return getPolicy(account, POLICIES.EXPENSE_CATEGORIZATION);
      },
    },
    [POLICIES.EXPENSE_PUBLIC_VENDORS]: {
      type: GraphQLBoolean,
      async resolve(account, _, req) {
        if (req.remoteUser?.isAdminOfCollectiveOrHost(account) && checkScope(req, 'account')) {
          return await getPolicy(account, POLICIES.EXPENSE_PUBLIC_VENDORS);
        }
      },
    },
    [POLICIES.COLLECTIVE_ADMINS_CAN_SEE_PAYOUT_METHODS]: {
      type: GraphQLBoolean,
      async resolve(account, _, req) {
        if (req.remoteUser?.isAdminOfCollectiveOrHost(account) && checkScope(req, 'account')) {
          return getPolicy(account, POLICIES.COLLECTIVE_ADMINS_CAN_SEE_PAYOUT_METHODS);
        }
      },
    },
    [POLICIES.CONTRIBUTOR_INFO_THRESHOLDS]: {
      type: new GraphQLObjectType({
        name: POLICIES.CONTRIBUTOR_INFO_THRESHOLDS,
        fields: () => ({
          legalName: { type: GraphQLInt },
          address: { type: GraphQLInt },
        }),
      }),
      description:
        'Contribution threshold to enforce contributor info. This resolver can be called from the collective or the host, when resolved through the collective the thresholds are returned in the collective currency',
      async resolve(account, args, req) {
        const host =
          account.HostCollectiveId && account.HostCollectiveId !== account.id
            ? await req.loaders.Collective.byId.load(account.HostCollectiveId)
            : account;
        let thresholds = await getPolicy(host, POLICIES.CONTRIBUTOR_INFO_THRESHOLDS, req);
        let fxRate = 1;
        if (!thresholds) {
          if (host.currency === 'USD') {
            thresholds = DEFAULT_CONTRIBUTION_INFO_USD_THRESHOLDS;
          } else {
            return null;
          }
        } else if (host.currency !== account.currency) {
          fxRate = await getFxRate(host.currency, account.currency);
        }
        return mapValues(thresholds, threshold => (isNil(threshold) ? null : Math.round(threshold * fxRate)));
      },
    },
  }),
});
