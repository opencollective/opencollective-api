import { GraphQLBoolean, GraphQLInputObjectType, GraphQLInt, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLLocale } from 'graphql-scalars';

export const GraphQLGoCardlessLinkInput = new GraphQLInputObjectType({
  name: 'GoCardlessLinkInput',
  description: 'Input for creating a GoCardless link',
  fields: {
    institutionId: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The institution ID for this requisition',
    },
    maxHistoricalDays: {
      type: GraphQLInt,
      description: 'Maximum number of days of transaction data to retrieve (default: 90)',
    },
    accessValidForDays: {
      type: GraphQLInt,
      description: 'Number of days from acceptance that the access can be used (default: 90)',
    },
    userLanguage: {
      type: GraphQLLocale,
      description: 'A two-letter country code (ISO 639-1) (default: "en")',
    },
    accountSelection: {
      type: GraphQLBoolean,
      description: 'Option to enable account selection view for the end user (default: true)',
    },
  },
});
