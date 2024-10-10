export enum Service {
  PAYPAL = 'paypal',
  STRIPE = 'stripe',
  STRIPE_CUSTOMER = 'stripe_customer',
  GITHUB = 'github',
  TWITTER = 'twitter',
  TRANSFERWISE = 'transferwise',
  PLAID = 'plaid',
  PRIVACY = 'privacy', // @deprecated
  THEGIVINGBLOCK = 'thegivingblock', // @deprecated
  MEETUP = 'meetup', // @deprecated
}

export const supportedServices = Object.values(Service);
