import { GraphQLBoolean, GraphQLInputFieldConfigMap, GraphQLInputObjectType, GraphQLString } from 'graphql';
import { pick } from 'lodash';
import moment from 'moment';

import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../constants/paymentMethods';
import { PaymentMethodLegacyType } from '../enum';
import { getServiceTypeFromLegacyPaymentMethodType } from '../enum/PaymentMethodLegacyType';
import { PaymentMethodService } from '../enum/PaymentMethodService';
import { PaymentMethodType } from '../enum/PaymentMethodType';

import { CreditCardCreateInput } from './CreditCardCreateInput';
import { fetchPaymentMethodWithReference } from './PaymentMethodReferenceInput';
import { PaypalPaymentInput } from './PaypalPaymentInput';

export const PaymentMethodInput = new GraphQLInputObjectType({
  name: 'PaymentMethodInput',
  description: 'An input to use for creating or retrieving payment methods',
  fields: (): GraphQLInputFieldConfigMap => ({
    id: {
      type: GraphQLString,
      description: 'The id assigned to the payment method',
    },
    service: {
      type: PaymentMethodService,
      description: 'Service of this payment method',
    },
    type: {
      type: PaymentMethodType,
      description: 'Type of this payment method',
    },
    legacyType: {
      type: PaymentMethodLegacyType,
      description: 'Type of this payment method',
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore `deprecationReason` is not yet exposed by graphql but it does exist
      deprecationReason: '2021-03-02: Please use service + type',
    },
    newType: {
      type: PaymentMethodType,
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
      type: CreditCardCreateInput,
      description: 'When creating a credit card, use this field to set its info',
    },
    paypalInfo: {
      type: PaypalPaymentInput,
      description: 'To pass when type is PAYPAL',
    },
  }),
});

/**
 * Helper that transforms a `PaymentMethodInput` into its GQLV1 sibling, making it safe to
 * pass to `createOrder` (legacy).
 */
export const getLegacyPaymentMethodFromPaymentMethodInput = async (
  pm: Record<string, any>,
): Promise<Record<string, unknown>> => {
  if (!pm) {
    return null;
  } else if (pm.id) {
    return fetchPaymentMethodWithReference(pm);
  }

  if (pm.creditCardInfo) {
    const paymentMethod = {
      service: PAYMENT_METHOD_SERVICE.STRIPE,
      type: PAYMENT_METHOD_TYPE.CREDITCARD,
      name: pm.name,
      save: pm.isSavedForLater,
      token: pm.creditCardInfo.token,
      data: pick(pm.creditCardInfo, ['brand', 'country', 'expMonth', 'expYear', 'fullName', 'funding', 'zip']),
    };
    if (pm.creditCardInfo.expYear && pm.creditCardInfo.expMonth) {
      const { expYear, expMonth } = pm.creditCardInfo;
      paymentMethod['expiryDate'] = moment.utc(`${expYear}-${expMonth}`, 'YYYY-MM').endOf('month');
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
  } else if (pm.legacyType) {
    return getServiceTypeFromLegacyPaymentMethodType(pm.legacyType);
  } else if (pm.service && pm.newType) {
    return { service: pm.service, type: pm.newType };
  } else if (pm.service && pm.type) {
    return { service: pm.service, type: pm.type };
  }
};
