import { GraphQLObjectType, GraphQLString } from 'graphql';

import { reportErrorToSentry } from '../../../lib/sentry';
import stripe from '../../../lib/stripe';
import ConnectedAccount from '../../../models/ConnectedAccount';

import { GraphQLAmount } from './Amount';

export const GraphQLStripeConnectedAccount = new GraphQLObjectType({
  name: 'StripeConnectedAccount',
  description: 'Stripe connected account properties',
  fields: () => ({
    username: {
      type: GraphQLString,
    },
    issuingBalance: {
      type: GraphQLAmount,
      async resolve(connectedAccount: ConnectedAccount) {
        try {
          const stripeBalance = await stripe.balance.retrieve({
            stripeAccount: connectedAccount.username,
          });

          const issuingBalance = stripeBalance?.issuing?.available?.[0];
          if (!issuingBalance) {
            return null;
          }

          return {
            currency: issuingBalance.currency.toUpperCase(),
            value: issuingBalance.amount,
          };
        } catch (e) {
          reportErrorToSentry(e);
          return null;
        }
      },
    },
  }),
});
