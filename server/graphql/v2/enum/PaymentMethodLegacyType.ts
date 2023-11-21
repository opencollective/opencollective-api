import { GraphQLEnumType } from 'graphql';

import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../constants/paymentMethods';
import logger from '../../../lib/logger';
import { PaymentMethodModelInterface } from '../../../models/PaymentMethod';

export enum PaymentMethodLegacyTypeEnum {
  ALIPAY = 'ALIPAY',
  CREDIT_CARD = 'CREDIT_CARD',
  GIFT_CARD = 'GIFT_CARD',
  PREPAID_BUDGET = 'PREPAID_BUDGET',
  ACCOUNT_BALANCE = 'ACCOUNT_BALANCE',
  PAYPAL = 'PAYPAL',
  BANK_TRANSFER = 'BANK_TRANSFER',
  ADDED_FUNDS = 'ADDED_FUNDS',
  CRYPTO = 'CRYPTO', // deprecated
  PAYMENT_INTENT = 'PAYMENT_INTENT',
  US_BANK_ACCOUNT = 'US_BANK_ACCOUNT',
  SEPA_DEBIT = 'SEPA_DEBIT',
  BACS_DEBIT = 'BACS_DEBIT',
  BANCONTACT = 'BANCONTACT',
}

export const GraphQLPaymentMethodLegacyType = new GraphQLEnumType({
  name: 'PaymentMethodLegacyType',
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore `deprecationReason` is not yet exposed by graphql but it does exist
  deprecationReason: '2021-03-02: Please use service + type',
  values: Object.keys(PaymentMethodLegacyTypeEnum).reduce((values, key) => {
    return { ...values, [key]: {} };
  }, {}),
});

export const getLegacyPaymentMethodType = ({
  service,
  type,
}: PaymentMethodModelInterface): PaymentMethodLegacyTypeEnum => {
  if (service === PAYMENT_METHOD_SERVICE.STRIPE) {
    if (type === PAYMENT_METHOD_TYPE.CREDITCARD) {
      return PaymentMethodLegacyTypeEnum.CREDIT_CARD;
    } else if (type === PAYMENT_METHOD_TYPE.US_BANK_ACCOUNT) {
      return PaymentMethodLegacyTypeEnum.US_BANK_ACCOUNT;
    } else if (type === PAYMENT_METHOD_TYPE.SEPA_DEBIT) {
      return PaymentMethodLegacyTypeEnum.SEPA_DEBIT;
    } else if (type === PAYMENT_METHOD_TYPE.BACS_DEBIT) {
      return PaymentMethodLegacyTypeEnum.BACS_DEBIT;
    } else if (type === PAYMENT_METHOD_TYPE.BANCONTACT) {
      return PaymentMethodLegacyTypeEnum.BANCONTACT;
    }
  } else if (service === PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE) {
    if (type === PAYMENT_METHOD_TYPE.GIFTCARD) {
      return PaymentMethodLegacyTypeEnum.GIFT_CARD;
    } else if (type === PAYMENT_METHOD_TYPE.HOST) {
      return PaymentMethodLegacyTypeEnum.ADDED_FUNDS;
    } else if (type === PAYMENT_METHOD_TYPE.COLLECTIVE) {
      return PaymentMethodLegacyTypeEnum.ACCOUNT_BALANCE;
    } else if (type === PAYMENT_METHOD_TYPE.PREPAID) {
      return PaymentMethodLegacyTypeEnum.PREPAID_BUDGET;
    }
  } else if (service === PAYMENT_METHOD_SERVICE.PAYPAL && type === PAYMENT_METHOD_TYPE.PAYMENT) {
    return PaymentMethodLegacyTypeEnum.PAYPAL;
  } else if (service === PAYMENT_METHOD_SERVICE.THEGIVINGBLOCK && type === PAYMENT_METHOD_TYPE.CRYPTO) {
    return PaymentMethodLegacyTypeEnum.CRYPTO;
  }

  logger.warn(`getPaymentMethodType: Unknown PM type for ${service}/${type}`);
};

type ServiceTypePair = { service: PAYMENT_METHOD_SERVICE; type: PAYMENT_METHOD_TYPE };

export const getServiceTypeFromLegacyPaymentMethodType = (type: PaymentMethodLegacyTypeEnum): ServiceTypePair => {
  switch (type) {
    case PaymentMethodLegacyTypeEnum.CREDIT_CARD:
      return { service: PAYMENT_METHOD_SERVICE.STRIPE, type: PAYMENT_METHOD_TYPE.CREDITCARD };
    case PaymentMethodLegacyTypeEnum.GIFT_CARD:
      return { service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE, type: PAYMENT_METHOD_TYPE.GIFTCARD };
    case PaymentMethodLegacyTypeEnum.PREPAID_BUDGET:
      return { service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE, type: PAYMENT_METHOD_TYPE.PREPAID };
    case PaymentMethodLegacyTypeEnum.ACCOUNT_BALANCE:
      return { service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE, type: PAYMENT_METHOD_TYPE.COLLECTIVE };
    case PaymentMethodLegacyTypeEnum.ADDED_FUNDS:
      return { service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE, type: PAYMENT_METHOD_TYPE.HOST };
    case PaymentMethodLegacyTypeEnum.BANK_TRANSFER:
      return { service: PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE, type: PAYMENT_METHOD_TYPE.MANUAL };
    case PaymentMethodLegacyTypeEnum.PAYPAL:
      return { service: PAYMENT_METHOD_SERVICE.PAYPAL, type: PAYMENT_METHOD_TYPE.PAYMENT };
    case PaymentMethodLegacyTypeEnum.ALIPAY:
      return { service: PAYMENT_METHOD_SERVICE.STRIPE, type: PAYMENT_METHOD_TYPE.ALIPAY };
    case PaymentMethodLegacyTypeEnum.CRYPTO:
      return { service: PAYMENT_METHOD_SERVICE.THEGIVINGBLOCK, type: PAYMENT_METHOD_TYPE.CRYPTO };
  }
};
