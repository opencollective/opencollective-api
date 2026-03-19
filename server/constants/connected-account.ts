export enum Service {
  PAYPAL = 'paypal',
  STRIPE = 'stripe',
  STRIPE_CUSTOMER = 'stripe_customer',
  GITHUB = 'github',
  TRANSFERWISE = 'transferwise',
  PLAID = 'plaid',
  GOCARDLESS = 'gocardless',
  /** @deprecated */
  TWITTER = 'twitter',
  /** @deprecated */
  PRIVACY = 'privacy',
  /** @deprecated */
  THEGIVINGBLOCK = 'thegivingblock',
  /** @deprecated */
  MEETUP = 'meetup',
}

export const supportedServices = Object.values(Service);
