import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import RateLimit from '../../../lib/rate-limit';
import PaypalPlanModel from '../../../models/PaypalPlan';
import Tier from '../../../models/Tier';
import { getOrCreatePlan } from '../../../paymentProviders/paypal/subscription';
import { RateLimitExceeded } from '../../errors';
import { GraphQLContributionFrequency } from '../enum';
import { getIntervalFromContributionFrequency } from '../enum/ContributionFrequency';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../input/AccountReferenceInput';
import { getValueInCentsFromAmountInput, GraphQLAmountInput } from '../input/AmountInput';
import { fetchOrderWithReference, GraphQLOrderReferenceInput } from '../input/OrderReferenceInput';
import { fetchTierWithReference, GraphQLTierReferenceInput } from '../input/TierReferenceInput';

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
    order: {
      type: GraphQLOrderReferenceInput,
      description: 'The order for which the plan is created, if any',
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
    if (!collective) {
      throw new Error('Account not found');
    }

    const tier =
      args.tier && <Tier>await fetchTierWithReference(args.tier, { loaders: req.loaders, throwIfMissing: true });
    const order = args.order && (await fetchOrderWithReference(args.order, { throwIfMissing: true }));
    if (tier && tier.CollectiveId !== collective.id) {
      throw new Error('The tier does not belong to the account');
    } else if (order && order.CollectiveId !== collective.id) {
      throw new Error('The order does not belong to the account');
    }

    const allowedCurrencies = [collective.currency, tier?.currency, order?.currency].filter(Boolean);
    const amount = getValueInCentsFromAmountInput(args.amount, { allowNilCurrency: false });
    const currency = args.amount.currency;
    if (!allowedCurrencies.includes(currency)) {
      throw new Error(`This currency is not allowed for PayPal, must be one of: ${allowedCurrencies.join(', ')}`);
    }

    const host = await collective.getHostCollective({ loaders: req.loaders });
    return getOrCreatePlan(host, collective, interval, amount, currency, tier);
  },
};

export default PaypalPlanQuery;
