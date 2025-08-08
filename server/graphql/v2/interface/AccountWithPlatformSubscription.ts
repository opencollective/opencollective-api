import assert from 'assert';

import { GraphQLInterfaceType, GraphQLNonNull } from 'graphql';
import { pick } from 'lodash';
import moment from 'moment';

import { Collective, PlatformSubscription } from '../../../models';
import { GraphQLAmount } from '../object/Amount';
import { GraphQLHostPlan } from '../object/HostPlan';
import {
  GraphQLPlatformBilling,
  GraphQLPlatformBillingPeriodInput,
  GraphQLPlatformSubscription,
} from '../object/PlatformSubscription';

export const AccountWithPlatformSubscriptionFields = {
  platformSubscription: {
    type: GraphQLPlatformSubscription,
    description: 'Returns the current platform subscription',
    async resolve(host: Collective, _, req: Express.Request) {
      return req.loaders.PlatformSubscription.currentByCollectiveId.load(host.id);
    },
  },
  platformBilling: {
    type: new GraphQLNonNull(GraphQLPlatformBilling),
    args: {
      billingPeriod: {
        type: GraphQLPlatformBillingPeriodInput,
      },
    },
    async resolve(host, args) {
      const billingPeriod = {
        year: moment.utc().year(),
        month: moment.utc().month() + 1,
      };

      if (args.billingPeriod) {
        billingPeriod.year = args.billingPeriod.year;
        billingPeriod.month = args.billingPeriod.month;
      }

      const subscriptions = await PlatformSubscription.getSubscriptionsInBillingPeriod(host.id, billingPeriod);
      const utilization = await PlatformSubscription.calculateUtilization(host.id, billingPeriod);

      return {
        billingPeriod,
        subscriptions,
        utilization,
      };
    },
  },
  managedAmount: {
    type: GraphQLAmount,
    description: 'The total amount managed by the account, including all its children accounts (events and projects)',
    resolve: async (account: Collective, _args, req: Express.Request) => {
      assert(req.remoteUser.isRoot());

      const result = await req.loaders.Collective.moneyManaged.load(account.id);
      return pick(result, ['value', 'currency']);
    },
  },
  plan: {
    type: new GraphQLNonNull(GraphQLHostPlan),
    resolve(account) {
      return account.getPlan();
    },
  },
};

export const GraphQLAccountWithPlatformSubscription = new GraphQLInterfaceType({
  name: 'AccountWithPlatformSubscription',
  description: 'An account that can be hosted by a Host',
  fields: () => AccountWithPlatformSubscriptionFields,
});
