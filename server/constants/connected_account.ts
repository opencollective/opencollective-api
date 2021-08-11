export enum Service {
  PAYPAL = 'paypal',
  STRIPE = 'stripe',
  GITHUB = 'github',
  TWITTER = 'twitter',
  TRANSFERWISE = 'transferwise',
  PRIVACY = 'privacy',
  THEGIVINGBLOCK = 'thegivingblock',
  MEETUP = 'meetup', // @deprecated
}

export const supportedServices = Object.values(Service);
