import { GraphQLInterfaceType, GraphQLNonNull } from 'graphql';

import { Collective, PlatformSubscription } from '../../../models';
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
      const billingPeriod = PlatformSubscription.currentBillingPeriod();

      if (args.billingPeriod) {
        billingPeriod.year = args.billingPeriod.year;
        billingPeriod.month = args.billingPeriod.month;
      }

      return PlatformSubscription.calculateBilling(host.id, billingPeriod);
    },
  },
  legacyPlan: {
    type: new GraphQLNonNull(GraphQLHostPlan),
    resolve(account) {
      return account.getPlan();
    },
  },
};

export const GraphQLAccountWithPlatformSubscription = new GraphQLInterfaceType({
  name: 'AccountWithPlatformSubscription',
  description: 'An account that can have a Platform Subscription',
  fields: () => AccountWithPlatformSubscriptionFields,
});
