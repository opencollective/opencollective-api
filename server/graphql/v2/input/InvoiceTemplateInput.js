import { GraphQLInputObjectType, GraphQLString } from 'graphql';

export const InvoiceTemplateInput = new GraphQLInputObjectType({
  name: 'InvoiceTemplateInput',
  description: 'Input type for receipt template.',
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
