import { GraphQLEnumType } from 'graphql';

export enum ACCOUNT_ORDER_BY_PSEUDO_FIELDS {
  ACTIVITY = 'ACTIVITY',
  BALANCE = 'BALANCE',
  CREATED_AT = 'CREATED_AT',
  HOST_RANK = 'HOST_RANK',
  RANK = 'RANK',
  HOSTED_COLLECTIVES_COUNT = 'HOSTED_COLLECTIVES_COUNT',
}

export const GraphQLAccountOrderByFieldType = new GraphQLEnumType({
  name: 'AccountOrderByFieldType',
  description: 'Possible fields you can use to order accounts by',
  values: {
    CREATED_AT: {},
    ACTIVITY: { description: 'The financial activity of the collective (number of transactions)' },
    HOST_RANK: {},
    HOSTED_COLLECTIVES_COUNT: {},
    RANK: {},
    BALANCE: {},
    NAME: {
      value: 'name',
    },
  },
});
