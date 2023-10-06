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
  PAYMENT_INTENT = 'paymentintent',
  US_BANK_ACCOUNT = 'us_bank_account',
  SEPA_DEBIT = 'sepa_debit',
  BACS_DEBIT = 'bacs_debit',
  BANCONTACT = 'bancontact',
}

export const PAYMENT_METHOD_TYPES = Object.values(PAYMENT_METHOD_TYPE);
