import { GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime, GraphQLJSON } from 'graphql-scalars';
import { get, omit, pick } from 'lodash';

import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../constants/paymentMethods';
import { checkScope } from '../../common/scope-check';
import { GraphQLOrderCollection } from '../collection/OrderCollection';
import { getLegacyPaymentMethodType, GraphQLPaymentMethodLegacyType } from '../enum/PaymentMethodLegacyType';
import { GraphQLPaymentMethodService } from '../enum/PaymentMethodService';
import { GraphQLPaymentMethodType } from '../enum/PaymentMethodType';
import { idEncode, IDENTIFIER_TYPES } from '../identifiers';
import { GraphQLAccount } from '../interface/Account';
import { GraphQLAmount } from '../object/Amount';
import { GraphQLHost } from '../object/Host';
import { OrdersCollectionArgs, OrdersCollectionResolver } from '../query/collection/OrdersCollectionQuery';

export const GraphQLPaymentMethod = new GraphQLObjectType({
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
        type: GraphQLString,
        async resolve(paymentMethod, _, req) {
          const publicProviders = [
            [PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE, PAYMENT_METHOD_TYPE.GIFTCARD],
            [PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE, PAYMENT_METHOD_TYPE.PREPAID],
            [PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE, PAYMENT_METHOD_TYPE.COLLECTIVE],
          ];

          const collective = await req.loaders.Collective.byId.load(paymentMethod.CollectiveId);
          if (
            (paymentMethod.CollectiveId &&
              req.remoteUser?.isAdminOfCollective(collective) &&
              checkScope(req, 'orders')) ||
            publicProviders.some(([service, type]) => paymentMethod.service === service && paymentMethod.type === type)
          ) {
            return paymentMethod.name;
          } else {
            return null;
          }
        },
      },
      service: {
        type: GraphQLPaymentMethodService,
      },
      type: {
        type: GraphQLPaymentMethodType,
      },
      providerType: {
        description: 'Defines the type of the payment method. Meant to be moved to "type" in the future.',
        deprecationReason: '2021-03-02: Please use service + type',
        type: GraphQLPaymentMethodLegacyType,
        resolve: getLegacyPaymentMethodType,
      },
      balance: {
        type: new GraphQLNonNull(GraphQLAmount),
        description: 'Returns the balance amount and the currency of this paymentMethod',
        async resolve(paymentMethod, args, req) {
          if (!req.remoteUser) {
            // We should return null here
            return { value: 0, currency: paymentMethod.currency };
          } else {
            const balance = await paymentMethod.getBalanceForUser(req.remoteUser);
            return { value: balance?.amount || 0, currency: paymentMethod.currency };
          }
        },
      },
      account: {
        type: GraphQLAccount,
        resolve(paymentMethod, _, req) {
          if (paymentMethod.CollectiveId) {
            return req.loaders.Collective.byId.load(paymentMethod.CollectiveId);
          }
        },
      },
      sourcePaymentMethod: {
        type: GraphQLPaymentMethod,
        description: 'For gift cards, this field will return to the source payment method',
        async resolve(paymentMethod, _, req) {
          const collective = await req.loaders.Collective.byId.load(paymentMethod.CollectiveId);
          if (
            paymentMethod.SourcePaymentMethodId &&
            req.remoteUser?.isAdminOfCollective(collective) &&
            checkScope(req, 'orders')
          ) {
            return req.loaders.PaymentMethod.byId.load(paymentMethod.SourcePaymentMethodId);
          }
        },
      },
      data: {
        type: GraphQLJSON,
        async resolve(paymentMethod, _, req) {
          const collective = await req.loaders.Collective.byId.load(paymentMethod.CollectiveId);
          if (!req.remoteUser?.isAdminOfCollective(collective) || !checkScope(req, 'orders')) {
            return null;
          }

          // Protect and limit fields
          let allowedFields = [];
          if (paymentMethod.type === PAYMENT_METHOD_TYPE.GIFTCARD) {
            allowedFields = ['email'];
          } else if (paymentMethod.type === PAYMENT_METHOD_TYPE.CREDITCARD) {
            allowedFields = ['fullName', 'expMonth', 'expYear', 'brand', 'country', 'last4', 'wallet.type'];
          }

          if (paymentMethod.service === PAYMENT_METHOD_SERVICE.STRIPE) {
            allowedFields.push('stripeAccount', 'stripePaymentMethodId');
          }

          return pick(paymentMethod.data, allowedFields);
        },
      },
      limitedToHosts: {
        type: new GraphQLList(GraphQLHost),
        async resolve(paymentMethod, args, req) {
          let hosts;
          if (paymentMethod.type === 'prepaid') {
            const hostId = get(paymentMethod, 'data.HostCollectiveId', null);
            if (!hostId) {
              return;
            }
            const host = await req.loaders.Collective.byId.load(hostId);
            hosts = [host];
          } else if (paymentMethod.type === PAYMENT_METHOD_TYPE.GIFTCARD && paymentMethod.limitedToHostCollectiveIds) {
            hosts = paymentMethod.limitedToHostCollectiveIds.map(id => {
              return req.loaders.Collective.byId.load(id);
            });
          } else if (paymentMethod.service === PAYMENT_METHOD_SERVICE.STRIPE && paymentMethod.data?.stripeAccount) {
            const host = await req.loaders.Collective.hostByStripeAccount.load(paymentMethod.data.stripeAccount);
            hosts = [host];
          } else if (paymentMethod.type === PAYMENT_METHOD_TYPE.COLLECTIVE) {
            const host = await req.loaders.Collective.hostByCollectiveId.load(paymentMethod.CollectiveId);
            hosts = [host];
          }

          return hosts;
        },
      },
      expiryDate: {
        type: GraphQLDateTime,
        async resolve(paymentMethod, _, req) {
          const collective = await req.loaders.Collective.byId.load(paymentMethod.CollectiveId);
          if (!req.remoteUser?.isAdminOfCollective(collective) || !checkScope(req, 'orders')) {
            return null;
          } else {
            return paymentMethod.expiryDate;
          }
        },
      },
      createdAt: {
        type: GraphQLDateTime,
      },
      monthlyLimit: {
        type: GraphQLAmount,
        description: 'For monthly gift cards, this field will return the monthly limit',
        resolve(paymentMethod) {
          if (paymentMethod.type !== PAYMENT_METHOD_TYPE.GIFTCARD || !paymentMethod.monthlyLimitPerMember) {
            return null;
          }

          return {
            value: paymentMethod.monthlyLimitPerMember,
            currency: paymentMethod.currency,
          };
        },
      },
      orders: {
        type: GraphQLOrderCollection,
        description: 'Get all the orders associated with this payment method',
        args: omit(OrdersCollectionArgs, 'paymentMethod'),
        async resolve(paymentMethod, args, req) {
          if (!checkScope(req, 'orders')) {
            return null;
          }

          const paymentMethodReference = { id: idEncode(paymentMethod.id, IDENTIFIER_TYPES.PAYMENT_METHOD) };
          return OrdersCollectionResolver({ ...args, paymentMethod: paymentMethodReference }, req);
        },
      },
    };
  },
});
