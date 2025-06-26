import { GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

export const GraphQLOffPlatformTransactionsInstitution = new GraphQLObjectType({
  name: 'OffPlatformTransactionsInstitution',
  description: 'A financial institution for off-platform transactions',
  fields: {
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The unique identifier for the institution',
    },
    name: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The name of the institution',
    },
    bic: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The BIC (Bank Identifier Code) of the institution',
    },
    logoUrl: {
      type: GraphQLString,
      description: 'URL to the institution logo',
    },
    supportedCountries: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))),
      description: 'List of country codes supported by this institution',
    },
    maxAccessValidForDays: {
      type: new GraphQLNonNull(GraphQLInt),
      description: 'Maximum number of days the access can be valid for',
    },
    transactionTotalDays: {
      type: new GraphQLNonNull(GraphQLInt),
      description: 'Total number of days of transaction data available',
    },
  },
});
