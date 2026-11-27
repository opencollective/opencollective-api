import { GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { GraphQLContributorInfoAddressField, GraphQLContributorInfoField } from '../enum/ContributorInfoField';

export const GraphQLPendingContributorInfoRequest = new GraphQLObjectType({
  name: 'PendingContributorInfoRequest',
  description: 'Information a fiscal host requested from an account that was not provided yet',
  fields: () => ({
    requestedAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'Date of the latest request with pending information',
    },
    fields: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLContributorInfoField))),
    },
    addressFields: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLContributorInfoAddressField))),
      description: 'The parts of the address still to correct. Empty when the whole address is pending.',
      resolve: request => request.addressParts,
    },
  }),
});
