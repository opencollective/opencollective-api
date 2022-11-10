export enum PAYMENT_METHOD_SERVICE {
  PAYPAL = 'paypal',
  STRIPE = 'stripe',
  OPENCOLLECTIVE = 'opencollective',
  PREPAID = 'prepaid',
  THEGIVINGBLOCK = 'thegivingblock',
}

export const PAYMENT_METHOD_SERVICES = Object.values(PAYMENT_METHOD_SERVICE);

export enum PAYMENT_METHOD_TYPE {
  ALIPAY = 'alipay',
  CREDITCARD = 'creditcard',
  PREPAID = 'prepaid',
  PAYMENT = 'payment',
  SUBSCRIPTION = 'subscription',
  COLLECTIVE = 'collective',
  HOST = 'host',
  ADAPTIVE = 'adaptive',
  GIFTCARD = 'giftcard',
  MANUAL = 'manual',
  CRYPTO = 'crypto',
  CHECKOUT = 'checkout',
}

export const PAYMENT_METHOD_TYPES = Object.values(PAYMENT_METHOD_TYPE);
