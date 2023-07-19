import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import RateLimit from '../../../lib/rate-limit.js';
import PaypalPlanModel from '../../../models/PaypalPlan.js';
import Tier from '../../../models/Tier.js';
import { getOrCreatePlan } from '../../../paymentProviders/paypal/subscription.js';
import { RateLimitExceeded } from '../../errors.js';
import { GraphQLContributionFrequency } from '../enum/index.js';
import { getIntervalFromContributionFrequency } from '../enum/ContributionFrequency.js';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput.js';
import { getValueInCentsFromAmountInput, GraphQLAmountInput } from '../input/AmountInput.js';
import { fetchTierWithReference, GraphQLTierReferenceInput } from '../input/TierReferenceInput.js';

const GraphQLPaypalPlan = new GraphQLObjectType({
  name: 'PaypalPlan',
  description: 'A PayPal plan to associate with a contribution',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
    },
  }),
});

const PaypalPlanQuery = {
  type: new GraphQLNonNull(GraphQLPaypalPlan),
  args: {
    account: {
      type: new GraphQLNonNull(GraphQLAccountReferenceInput),
      description: 'The account that serves as a payment target',
    },
    amount: {
      type: new GraphQLNonNull(GraphQLAmountInput),
      description: 'The contribution amount for 1 quantity, without platform contribution and taxes',
    },
    frequency: {
      type: new GraphQLNonNull(GraphQLContributionFrequency),
    },
    tier: {
      type: GraphQLTierReferenceInput,
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
    const tier =
      args.tier && <Tier>await fetchTierWithReference(args.tier, { loaders: req.loaders, throwIfMissing: true });
    const expectedCurrency = tier?.currency || collective?.currency;
    const amount = getValueInCentsFromAmountInput(args.amount, { expectedCurrency, allowNilCurrency: false });
    const currency = args.amount.currency;
    const host = await collective.getHostCollective({ loaders: req.loaders });
    return getOrCreatePlan(host, collective, interval, amount, currency, tier);
  },
};

export default PaypalPlanQuery;
