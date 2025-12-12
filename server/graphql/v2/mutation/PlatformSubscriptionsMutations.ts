import assert from 'assert';

import { GraphQLNonNull, GraphQLString } from 'graphql';

import { PlatformSubscriptionPlan, PlatformSubscriptionTiers } from '../../../constants/plans';
import { Collective, PlatformSubscription } from '../../../models';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { GraphQLPlatformSubscriptionInput } from '../input/PlatformSubcriptionInput';
import { GraphQLAccount } from '../interface/Account';

const platformSubscriptionMutations = {
  updateAccountPlatformSubscription: {
    type: new GraphQLNonNull(GraphQLAccount),
    args: {
      account: {
        type: new GraphQLNonNull(GraphQLAccountReferenceInput),
        description: 'Account to update the platform subscription for',
      },
      planId: {
        type: GraphQLString,
      },
      subscription: {
        type: GraphQLPlatformSubscriptionInput,
        description: 'The new platform subscription tier to apply to the account',
      },
    },
    async resolve(_, args, req: Express.Request): Promise<Collective> {
      if (!req.remoteUser) {
        throw new Error('You need to be logged in to update a platform subscription');
      }
      const account = await fetchAccountWithReference(args.account, { throwIfMissing: true, paranoid: false });

      let plan: Partial<PlatformSubscriptionPlan>;
      if (args.planId) {
        plan = PlatformSubscriptionTiers.find(plan => plan.id === args.planId);
        if (!plan) {
          throw new Error('Invalid plan ID');
        }

        if (!req.remoteUser.isRoot() && !req.remoteUser.isAdminOfCollective(account)) {
          throw new Error('User cannot update subscription');
        }
      } else {
        if (!req.remoteUser.isRoot()) {
          throw new Error('Only root users can set custom platform plans');
        }

        assert(
          args.subscription.plan.pricing.pricePerMonth.currency === 'USD',
          'Only USD is supported for platform subscription pricing',
        );
        assert(
          args.subscription.plan.pricing.pricePerAdditionalCollective.currency === 'USD',
          'Only USD is supported for platform subscription pricing',
        );
        assert(
          args.subscription.plan.pricing.pricePerAdditionalExpense.currency === 'USD',
          'Only USD is supported for platform subscription pricing',
        );

        plan = {
          title: args.subscription.plan.title,
          type: args.subscription.plan.type,
          basePlanId: args.subscription.plan.basePlanId,
          pricing: {
            pricePerMonth: args.subscription.plan.pricing.pricePerMonth.valueInCents,
            pricePerAdditionalCollective: args.subscription.plan.pricing.pricePerAdditionalCollective.valueInCents,
            pricePerAdditionalExpense: args.subscription.plan.pricing.pricePerAdditionalExpense.valueInCents,
            includedCollectives: args.subscription.plan.pricing.includedCollectives,
            includedExpensesPerMonth: args.subscription.plan.pricing.includedExpensesPerMonth,
          },
          features: args.subscription.plan.features,
        };
      }

      await PlatformSubscription.replaceCurrentSubscription(account, new Date(), plan, req.remoteUser, {
        UserTokenId: req.userToken?.id,
      });

      return account.update({ plan: null });
    },
  },
};

export default platformSubscriptionMutations;
