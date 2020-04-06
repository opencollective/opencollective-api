export enum Service {
  PAYPAL = 'paypal',
  STRIPE = 'stripe',
  GITHUB = 'github',
  TWITTER = 'twitter',
  MEETUP = 'meetup',
  TRANSFERWISE = 'transferwise',
}

export const supportedServices = Object.values(Service);
