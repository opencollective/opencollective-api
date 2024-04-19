import { GraphQLEnumType } from 'graphql';

export enum ACCOUNT_ORDER_BY_PSEUDO_FIELDS {
  CREATED_AT = 'CREATED_AT',
  BALANCE = 'BALANCE',
}

export const GraphQLAccountOrderByFieldType = new GraphQLEnumType({
  name: 'AccountOrderByFieldType',
  description: 'Possible fields you can use to order accounts by',
  values: {
    CREATED_AT: {},
    ACTIVITY: { description: 'The financial activity of the collective (number of transactions)' },
    RANK: {},
    BALANCE: {},
    NAME: {
      value: 'name',
    },
  },
});
