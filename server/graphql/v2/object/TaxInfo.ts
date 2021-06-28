import { GraphQLInt, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

export const TaxInfo = new GraphQLObjectType({
  name: 'TaxInfo',
  description: 'Information about a tax',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'An unique identifier for this tax (GST, VAT, etc)',
    },
    percentage: {
      type: new GraphQLNonNull(GraphQLInt),
      description: 'Percentage applied, between 0-100',
    },
  }),
});
