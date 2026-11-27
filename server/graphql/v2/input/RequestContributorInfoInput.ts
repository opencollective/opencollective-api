import { GraphQLInputObjectType, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';

import { GraphQLContributorInfoAddressField, GraphQLContributorInfoField } from '../enum/ContributorInfoField';

import { GraphQLAccountReferenceInput } from './AccountReferenceInput';

export const GraphQLRequestContributorInfoInput = new GraphQLInputObjectType({
  name: 'RequestContributorInfoInput',
  fields: () => ({
    host: {
      type: new GraphQLNonNull(GraphQLAccountReferenceInput),
      description: 'The fiscal host requesting the information',
    },
    account: {
      type: new GraphQLNonNull(GraphQLAccountReferenceInput),
      description: 'The individual or organization to request the information from',
    },
    fields: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLContributorInfoField))),
      description: 'The information to add or correct',
    },
    addressFields: {
      type: new GraphQLList(new GraphQLNonNull(GraphQLContributorInfoAddressField)),
      description: 'With ADDRESS only: the parts of the address to correct. Empty for the whole address.',
    },
    message: {
      type: GraphQLString,
      description: 'An optional plain text message included in the email',
    },
  }),
});
