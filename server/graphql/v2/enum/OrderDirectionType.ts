import { GraphQLEnumType } from 'graphql';

export const GraphQLOrderDirectionType = new GraphQLEnumType({
  name: 'OrderDirection',
  description: 'Possible directions in which to order a list of items',
  values: {
    ASC: {},
    DESC: {},
  },
});
