import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import RateLimit from '../../../lib/rate-limit';
import PaypalPlanModel from '../../../models/PaypalPlan';
import { getOrCreatePlan } from '../../../paymentProviders/paypal/subscription';
import { RateLimitExceeded } from '../../errors';
import { ContributionFrequency } from '../enum';
import { getIntervalFromContributionFrequency } from '../enum/ContributionFrequency';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { AmountInput, getValueInCentsFromAmountInput } from '../input/AmountInput';
import { fetchTierWithReference, TierReferenceInput } from '../input/TierReferenceInput';

const PaypalPlan = new GraphQLObjectType({
  name: 'PaypalPlan',
  description: 'A PayPal plan to associate with a contribution',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
    },
  }),
});

const PaypalPlanQuery = {
  type: new GraphQLNonNull(PaypalPlan),
  args: {
    account: {
      type: new GraphQLNonNull(AccountReferenceInput),
      description: 'The account that serves as a payment target',
    },
    amount: {
      type: new GraphQLNonNull(AmountInput),
      description: 'The contribution amount for 1 quantity, without platform contribution and taxes',
    },
    frequency: {
      type: new GraphQLNonNull(ContributionFrequency),
    },
    tier: {
      type: TierReferenceInput,
      description: 'The tier you are contributing to',
    },
  },
  async resolve(_, args, req): Promise<PaypalPlanModel> {
    const rateLimit = new RateLimit(`paypal_plan_${req.remoteUser?.id || req.ip}`, 30, 60);
    if (!(await rateLimit.registerCall())) {
      throw new RateLimitExceeded();
    }

    const interval = getIntervalFromContributionFrequency(args.frequency);
    if (!interval) {
      throw new Error('An interval must be provided to fetch PayPal plans');
    }

    const collective = await fetchAccountWithReference(args.account, { loaders: req.loaders, throwIfMissing: true });
    const tier = args.tier && (await fetchTierWithReference(args.tier, { loaders: req.loaders, throwIfMissing: true }));
    const expectedCurrency = tier?.currency || collective?.currency;
    const amount = getValueInCentsFromAmountInput(args.amount, { expectedCurrency });
    const currency = args.amount.currency;
    const host = await collective.getHostCollective();
    return getOrCreatePlan(host, collective, interval, amount, currency, tier);
  },
};

export default PaypalPlanQuery;
