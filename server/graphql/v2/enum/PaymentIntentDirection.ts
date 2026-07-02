import { GraphQLEnumType } from 'graphql';

export enum GraphQLPaymentIntentDirectionValues {
  INCOMING = 'INCOMING',
  OUTGOING = 'OUTGOING',
}

export const GraphQLPaymentIntentDirection = new GraphQLEnumType({
  name: 'PaymentIntentDirection',
  description: 'Payment intent direction relative to the filtered account (INCOMING = payee, OUTGOING = payer)',
  values: {
    INCOMING: {},
    OUTGOING: {},
  } satisfies Record<keyof typeof GraphQLPaymentIntentDirectionValues, object>,
});
