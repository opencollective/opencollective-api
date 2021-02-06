export enum Service {
  PAYPAL = 'paypal',
  STRIPE = 'stripe',
  GITHUB = 'github',
  TWITTER = 'twitter',
  TRANSFERWISE = 'transferwise',
  MEETUP = 'meetup', // @deprecated
}

export const supportedServices = Object.values(Service);
