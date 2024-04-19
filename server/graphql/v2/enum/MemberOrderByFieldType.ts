import { GraphQLEnumType } from 'graphql';

export enum MEMBER_ORDER_BY_PSEUDO_FIELDS {
  MEMBER_COUNT = 'MEMBER_COUNT',
  TOTAL_CONTRIBUTED = 'TOTAL_CONTRIBUTED',
  CREATED_AT = 'CREATED_AT',
}

export const GraphQLMemberOrderByFieldType = new GraphQLEnumType({
  name: 'MemberOrderByFieldType',
  description: 'Possible fields you can use to order members by',
  values: {
    CREATED_AT: {},
    MEMBER_COUNT: {},
    TOTAL_CONTRIBUTED: {},
  },
});
