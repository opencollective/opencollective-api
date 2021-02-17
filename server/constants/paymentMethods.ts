export enum PAYMENT_METHOD_SERVICE {
  PAYPAL = 'paypal',
  BRAINTREE = 'braintree',
  STRIPE = 'stripe',
  OPENCOLLECTIVE = 'opencollective',
  PREPAID = 'prepaid',
}
export const PAYMENT_METHOD_SERVICES = Object.values(PAYMENT_METHOD_SERVICE);

export enum PAYMENT_METHOD_TYPE {
  CREDITCARD = 'creditcard',
  PREPAID = 'prepaid',
  PAYMENT = 'payment',
  COLLECTIVE = 'collective',
  HOST = 'host',
  ADAPTIVE = 'adaptive',
  PAYPAL = 'paypal',
  GIFT_CARD = 'giftcard',
  MANUAL = 'manual',
}
export const PAYMENT_METHOD_TYPES = Object.values(PAYMENT_METHOD_TYPE);
