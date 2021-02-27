import { GraphQLEnumType } from 'graphql';

import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../constants/paymentMethods';
import logger from '../../../lib/logger';
import { PaymentMethod } from '../../../types/PaymentMethod';

enum PaymentMethodTypeEnum {
  CREDIT_CARD = 'CREDIT_CARD',
  GIFT_CARD = 'GIFT_CARD',
  PREPAID_BUDGET = 'PREPAID_BUDGET',
  ACCOUNT_BALANCE = 'ACCOUNT_BALANCE',
  PAYPAL = 'PAYPAL',
  BANK_TRANSFER = 'BANK_TRANSFER',
  ADDED_FUNDS = 'ADDED_FUNDS',
}

export const PaymentMethodType = new GraphQLEnumType({
  name: 'PaymentMethodType',
  values: Object.keys(PaymentMethodTypeEnum).reduce((values, key) => {
    return { ...values, [key]: {} };
  }, {}),
});

export const getPaymentMethodType = ({ service, type }: PaymentMethod): PaymentMethodTypeEnum => {
  if (service === PAYMENT_METHOD_SERVICE.STRIPE) {
    if (type === PAYMENT_METHOD_TYPE.CREDITCARD) {
      return PaymentMethodTypeEnum.CREDIT_CARD;
    }
  } else if (service === PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE) {
    if (type === PAYMENT_METHOD_TYPE.GIFT_CARD) {
      return PaymentMethodTypeEnum.GIFT_CARD;
    } else if (type === PAYMENT_METHOD_TYPE.HOST) {
      return PaymentMethodTypeEnum.ADDED_FUNDS;
    } else if (type === PAYMENT_METHOD_TYPE.COLLECTIVE) {
      return PaymentMethodTypeEnum.ACCOUNT_BALANCE;
    } else if (type === PAYMENT_METHOD_TYPE.PREPAID) {
      return PaymentMethodTypeEnum.PREPAID_BUDGET;
    }
  } else if (service === PAYMENT_METHOD_SERVICE.PAYPAL) {
    if (type === PAYMENT_METHOD_TYPE.PAYMENT) {
      return PaymentMethodTypeEnum.PAYPAL;
    }
  }

  logger.warn(`getPaymentMethodType: Unknown PM type for ${service}/${type}`);
};

type ServiceTypePair = { service: PAYMENT_METHOD_SERVICE; type: PAYMENT_METHOD_TYPE };

export const getLegacyServiceTypeFromPaymentMethodType = (type: PaymentMethodTypeEnum): ServiceTypePair => {
  switch (type) {
    case PaymentMethodTypeEnum.CREDIT_CARD:
      return { service: PAYMENT_METHOD_SERVICE.STRIPE, type: PAYMENT_METHOD_TYPE.CREDITCARD };
    case PaymentMethodTypeEnum.GIFT_CARD:
      return { service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE, type: PAYMENT_METHOD_TYPE.GIFT_CARD };
    case PaymentMethodTypeEnum.PREPAID_BUDGET:
      return { service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE, type: PAYMENT_METHOD_TYPE.PREPAID };
    case PaymentMethodTypeEnum.ACCOUNT_BALANCE:
      return { service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE, type: PAYMENT_METHOD_TYPE.COLLECTIVE };
    case PaymentMethodTypeEnum.ADDED_FUNDS:
      return { service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE, type: PAYMENT_METHOD_TYPE.HOST };
    case PaymentMethodTypeEnum.BANK_TRANSFER:
      return { service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE, type: PAYMENT_METHOD_TYPE.MANUAL };
    case PaymentMethodTypeEnum.PAYPAL:
      return { service: PAYMENT_METHOD_SERVICE.PAYPAL, type: PAYMENT_METHOD_TYPE.PAYMENT };
  }
};
