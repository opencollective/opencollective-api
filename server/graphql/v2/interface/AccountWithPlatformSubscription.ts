import { GraphQLInterfaceType, GraphQLNonNull } from 'graphql';
import moment from 'moment';

import { Collective, PlatformSubscription } from '../../../models';
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
};

export const GraphQLAccountWithPlatformSubscription = new GraphQLInterfaceType({
  name: 'AccountWithPlatformSubscription',
  description: 'An account that can be hosted by a Host',
  fields: () => AccountWithPlatformSubscriptionFields,
});
