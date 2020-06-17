import { GraphQLInt, GraphQLObjectType, GraphQLString } from 'graphql';
import GraphQLJSON from 'graphql-type-json';
import { pick } from 'lodash';

import { idEncode } from '../identifiers';
import { Account } from '../interface/Account';
import { Amount } from '../object/Amount';

export const PaymentMethod = new GraphQLObjectType({
  name: 'PaymentMethod',
  description: 'PaymentMethod model',
  fields: () => {
    return {
      id: {
        type: GraphQLString,
        resolve(paymentMethod) {
          return idEncode(paymentMethod.id, 'paymentMethod');
        },
      },
      legacyId: {
        type: GraphQLInt,
        resolve(paymentMethod) {
          return paymentMethod.id;
        },
      },
      name: {
        // last 4 digit of card number for Stripe
        type: GraphQLString,
      },
      service: {
        type: GraphQLString,
      },
      type: {
        type: GraphQLString,
      },
      balance: {
        type: Amount,
        description: 'Returns the balance amount and the currency of this paymentMethod',
        async resolve(paymentMethod, args, req) {
          const balance = await paymentMethod.getBalanceForUser(req.remoteUser);
          return { value: balance.amount, currency: paymentMethod.currency };
        },
      },
      account: {
        type: Account,
        resolve(paymentMethod, _, req) {
          return req.loaders.Collective.byId.load(paymentMethod.CollectiveId);
        },
      },
      data: {
        type: GraphQLJSON,
        resolve(paymentMethod, _, req) {
          if (!paymentMethod.data) {
            return null;
          }

          // Protect and whitelist fields for virtualcard
          if (paymentMethod.type === 'virtualcard') {
            if (!req.remoteUser || !req.remoteUser.isAdmin(paymentMethod.CollectiveId)) {
              return null;
            }
            return pick(paymentMethod.data, ['email']);
          }

          const data = paymentMethod.data;
          // white list fields to send back; removes fields like CustomerIdForHost
          const dataSubset = pick(data, ['fullName', 'expMonth', 'expYear', 'brand', 'country', 'last4']);

          return dataSubset;
        },
      },
    };
  },
});
