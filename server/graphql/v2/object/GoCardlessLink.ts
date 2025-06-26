import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import GraphQLURL from '../scalar/URL';

export const GraphQLGoCardlessLink = new GraphQLObjectType({
  name: 'GoCardlessLink',
  description: 'A GoCardless link for bank account data access',
  fields: {
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The unique identifier for the requisition',
    },
    createdAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'The date & time at which the requisition was created',
    },
    redirect: {
      type: new GraphQLNonNull(GraphQLURL),
      description: 'Redirect URL to your application after end-user authorization with ASPSP',
    },
    institutionId: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The institution ID for this requisition',
    },
    link: {
      type: GraphQLString,
      description: 'Link to initiate authorization with Institution',
    },
  },
});
