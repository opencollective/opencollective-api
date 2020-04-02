export enum PAYMENT_METHOD_SERVICE {
  PAYPAL = 'paypal',
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
  ADAPTIVE = 'adaptive',
  VIRTUALCARD = 'virtualcard',
}
export const PAYMENT_METHOD_TYPES = Object.values(PAYMENT_METHOD_TYPE);
