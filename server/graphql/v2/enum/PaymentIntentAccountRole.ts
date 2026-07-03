import { GraphQLEnumType } from 'graphql';

export enum GraphQLPaymentIntentAccountRoleEnum {
  HOST = 'HOST',
  PAYER = 'PAYER',
  PAYEE = 'PAYEE',
}

export const GraphQLPaymentIntentAccountRole = new GraphQLEnumType({
  name: 'PaymentIntentAccountRole',
  description: 'Role of the account in the payment intent',
  values: {
    [GraphQLPaymentIntentAccountRoleEnum.HOST]: {
      description: 'The host in which ledger entries are recorded',
    },
    [GraphQLPaymentIntentAccountRoleEnum.PAYER]: {
      description: 'The account that is paying',
    },
    [GraphQLPaymentIntentAccountRoleEnum.PAYEE]: {
      description: 'The account that is receiving the money',
    },
  } satisfies Record<GraphQLPaymentIntentAccountRoleEnum, { description: string }>,
});
