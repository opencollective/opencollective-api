import { GraphQLObjectType, GraphQLString } from 'graphql';

export const InvoiceTemplate = new GraphQLObjectType({
  name: 'InvoiceTemplate',
  description: 'Represents a receipt template.',
  fields: () => ({
    title: {
      type: GraphQLString,
      description: 'The title of the template.',
    },
    info: {
      type: GraphQLString,
      description: 'Information about the particular template.',
    },
  }),
});
