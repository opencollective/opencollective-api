import { GraphQLBoolean, GraphQLInputFieldConfigMap, GraphQLInputObjectType, GraphQLString } from 'graphql';
import { pick } from 'lodash';
import moment from 'moment';

import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../constants/paymentMethods';
import stripe from '../../../lib/stripe';
import { GraphQLPaymentMethodLegacyType } from '../enum';
import { getServiceTypeFromLegacyPaymentMethodType } from '../enum/PaymentMethodLegacyType';
import { GraphQLPaymentMethodService } from '../enum/PaymentMethodService';
import { GraphQLPaymentMethodType } from '../enum/PaymentMethodType';

import { GraphQLCreditCardCreateInput } from './CreditCardCreateInput';
import { fetchPaymentMethodWithReference } from './PaymentMethodReferenceInput';
import { GraphQLPaypalPaymentInput } from './PaypalPaymentInput';

export const GraphQLPaymentMethodInput = new GraphQLInputObjectType({
  name: 'PaymentMethodInput',
  description: 'An input to use for creating or retrieving payment methods',
  fields: (): GraphQLInputFieldConfigMap => ({
    id: {
      type: GraphQLString,
      description: 'The id assigned to the payment method',
    },
    service: {
      type: GraphQLPaymentMethodService,
      description: 'Service of this payment method',
    },
    type: {
      type: GraphQLPaymentMethodType,
      description: 'Type of this payment method',
    },
    legacyType: {
      type: GraphQLPaymentMethodLegacyType,
      description: 'Type of this payment method',
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore `deprecationReason` is not yet exposed by graphql but it does exist
      deprecationReason: '2021-03-02: Please use service + type',
    },
    newType: {
      type: GraphQLPaymentMethodType,
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore `deprecationReason` is not yet exposed by graphql but it does exist
      deprecationReason: '2021-08-20: Please use type instead',
    },
    name: {
      type: GraphQLString,
      description: 'Name of this payment method',
    },
    isSavedForLater: {
      type: GraphQLBoolean,
      description: 'Whether this payment method should be saved for future payments',
    },
    creditCardInfo: {
      type: GraphQLCreditCardCreateInput,
      description: 'When creating a credit card, use this field to set its info',
    },
    paypalInfo: {
      type: GraphQLPaypalPaymentInput,
      description: 'To pass when type is PAYPAL',
    },
    paymentIntentId: {
      type: GraphQLString,
      description: 'The Payment Intent ID used in this checkout',
    },
  }),
});

/**
 * Helper that transforms a `PaymentMethodInput` into its GQLV1 sibling, making it safe to
 * pass to `createOrder` (legacy).
 */
export const getLegacyPaymentMethodFromPaymentMethodInput = async (
  pm: Record<string, any>,
): Promise<Record<string, unknown> | { service: string; type: PAYMENT_METHOD_TYPE }> => {
  if (!pm) {
    return null;
  } else if (pm.id) {
    return fetchPaymentMethodWithReference(pm);
  }

  if (pm.creditCardInfo) {
    const token = await stripe.tokens.retrieve(pm.creditCardInfo.token);
    const paymentMethod = {
      service: PAYMENT_METHOD_SERVICE.STRIPE,
      type: PAYMENT_METHOD_TYPE.CREDITCARD,
      name: token.card.last4,
      save: pm.isSavedForLater,
      token: pm.creditCardInfo.token,
      data: {
        ...pick(pm.creditCardInfo, ['zip']), // Not returned by Stripe
        ...pick(token.card, ['brand', 'country', 'funding', 'fingerprint', 'last4']), // Returned by Stripe
        name: token.card.name,
        expMonth: token.card.exp_month,
        expYear: token.card.exp_year,
      },
    };
    if (paymentMethod.data.expYear && paymentMethod.data.expMonth) {
      const { expYear, expMonth } = paymentMethod.data;
      paymentMethod['expiryDate'] = moment.utc(`${expYear}-${expMonth}`, 'YYYY-MM').endOf('month');
    }
    // Internal fallback for card fingerprint
    if (!paymentMethod.data?.fingerprint) {
      paymentMethod.data.fingerprint = [
        paymentMethod.name,
        ...Object.values(pick(paymentMethod.data, ['brand', 'expMonth', 'expYear', 'funding'])),
      ].join('-');
    }
    return paymentMethod;
  } else if (pm.paypalInfo) {
    if (pm.paypalInfo.subscriptionId) {
      return {
        service: PAYMENT_METHOD_SERVICE.PAYPAL,
        type: PAYMENT_METHOD_TYPE.SUBSCRIPTION,
        token: pm.paypalInfo.subscriptionId,
      };
    } else {
      return {
        service: PAYMENT_METHOD_SERVICE.PAYPAL,
        type: PAYMENT_METHOD_TYPE.PAYMENT,
        ...pick(pm.paypalInfo, ['token']),
        data: {
          ...(pm.paypalInfo.data || {}),
          ...pick(pm.paypalInfo, ['orderId']),
        },
      };
    }
  } else if (pm.paymentIntentId) {
    return { service: pm.service, type: pm.newType, paymentIntentId: pm.paymentIntentId, save: pm.isSavedForLater };
  } else if (pm.legacyType) {
    return getServiceTypeFromLegacyPaymentMethodType(pm.legacyType);
  } else if (pm.service && pm.newType) {
    return { service: pm.service, type: pm.newType };
  } else if (pm.service && pm.type) {
    return { service: pm.service, type: pm.type };
  }
};
