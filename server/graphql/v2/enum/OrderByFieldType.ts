import { GraphQLEnumType } from 'graphql';

export enum ORDER_BY_PSEUDO_FIELDS {
  ACTIVITY = 'ACTIVITY',
  BALANCE = 'BALANCE',
  CREATED_AT = 'CREATED_AT',
  LAST_CHARGED_AT = 'LAST_CHARGED_AT',
  HOST_RANK = 'HOST_RANK',
  RANK = 'RANK',
  HOSTED_COLLECTIVES_COUNT = 'HOSTED_COLLECTIVES_COUNT',
  MEMBER_COUNT = 'MEMBER_COUNT',
  TOTAL_CONTRIBUTED = 'TOTAL_CONTRIBUTED',
  STARTS_AT = 'STARTS_AT',
  ENDS_AT = 'ENDS_AT',
  UNHOSTED_AT = 'UNHOSTED_AT',
}

export const GraphQLOrderByFieldType = new GraphQLEnumType({
  name: 'OrderByFieldType',
  description: 'Possible fields you can use to order by',
  values: {
    CREATED_AT: {},
    LAST_CHARGED_AT: {},
    ACTIVITY: { description: 'The financial activity of the collective (number of transactions)' },
    HOST_RANK: {},
    HOSTED_COLLECTIVES_COUNT: {},
    RANK: {},
    BALANCE: {},
    MEMBER_COUNT: {},
    TOTAL_CONTRIBUTED: {},
    NAME: {
      value: 'name',
    },
    STARTS_AT: {
      description: 'Order by start date',
    },
    ENDS_AT: {
      description: 'Order by end date',
    },
    UNHOSTED_AT: {
      description: 'Order by the date the collective was unhosted',
    },
  },
});
