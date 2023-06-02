import { GraphQLEnumType } from 'graphql';

export enum ORDER_BY_PSEUDO_FIELDS {
  MEMBER_COUNT = 'MEMBER_COUNT',
  TOTAL_CONTRIBUTED = 'TOTAL_CONTRIBUTED',
  CREATED_AT = 'CREATED_AT',
}

// TODO: This should be called "AccountOrderByField", as the fields are only available for accounts
export const GraphQLOrderByFieldType = new GraphQLEnumType({
  name: 'OrderByFieldType',
  description: 'Possible fields you can use to order by',
  values: {
    CREATED_AT: {},
    MEMBER_COUNT: {},
    TOTAL_CONTRIBUTED: {},
    ACTIVITY: { description: 'The financial activity of the collective (number of transactions)' },
    RANK: {},
  },
});
