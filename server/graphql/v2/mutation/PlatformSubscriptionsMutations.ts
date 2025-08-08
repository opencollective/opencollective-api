import { GraphQLNonNull } from 'graphql';

import { PlatformSubscriptionPlan } from '../../../constants/plans';
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
      subscription: {
        type: new GraphQLNonNull(GraphQLPlatformSubscriptionInput),
        description: 'The new platform subscription tier to apply to the account',
      },
    },
    async resolve(_, args, req: Express.Request): Promise<Collective> {
      if (!req.remoteUser) {
        throw new Error('You need to be logged in to update a platform subscription');
      }
      const account = await fetchAccountWithReference(args.account, { throwIfMissing: true, paranoid: false });
      if (req.remoteUser.isRoot()) {
        const plan: Partial<PlatformSubscriptionPlan> = {
          title: args.subscription.plan.title,
          type: args.subscription.plan.type,
          pricing: {
            pricePerMonth: args.subscription.plan.pricing.pricePerMonth.valueInCents,
            pricePerAdditionalCollective: args.subscription.plan.pricing.pricePerAdditionalCollective.valueInCents,
            pricePerAdditionalExpense: args.subscription.plan.pricing.pricePerAdditionalExpense.valueInCents,
            includedCollectives: args.subscription.plan.pricing.includedCollectives,
            includedExpensesPerMonth: args.subscription.plan.pricing.includedExpensesPerMonth,
          },
        };
        await PlatformSubscription.replaceCurrentSubscription(account.id, new Date(), plan);
        await account.update({ plan: null });
        return account;
      } else {
        throw new Error('Not implemented: Only root users can update platform subscriptions');
      }
    },
  },
};

export default platformSubscriptionMutations;
