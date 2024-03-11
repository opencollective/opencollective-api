export enum PAYMENT_METHOD_SERVICE {
  PAYPAL = 'paypal',
  STRIPE = 'stripe',
  OPENCOLLECTIVE = 'opencollective',
  PREPAID = 'prepaid',
  THEGIVINGBLOCK = 'thegivingblock', // @deprecated
  WISE = 'wise',
}

export const PAYMENT_METHOD_SERVICES = Object.values(PAYMENT_METHOD_SERVICE);

export enum PAYMENT_METHOD_TYPE {
  DEFAULT = 'default',
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
  CRYPTO = 'crypto', // @deprecated
  PAYMENT_INTENT = 'paymentintent',
  US_BANK_ACCOUNT = 'us_bank_account',
  SEPA_DEBIT = 'sepa_debit',
  BACS_DEBIT = 'bacs_debit',
  BANCONTACT = 'bancontact',
  LINK = 'link',
  BANK_TRANSFER = 'bank_transfer',
  PAYOUT = 'payout',
  VIRTUAL_CARD = 'virtual_card',
}

export const PAYMENT_METHOD_TYPES = Object.values(PAYMENT_METHOD_TYPE);
