import { GraphQLString, GraphQLNonNull, GraphQLObjectType } from 'graphql';
import { GraphQLDateTime } from 'graphql-iso-date';
import GraphQLJSON from 'graphql-type-json';
import { ConnectedAccountService } from '../enum/ConnectedAccountService';

export const ConnectedAccount = new GraphQLObjectType({
  name: 'ConnectedAccount',
  description: 'Fields for an connected account',
  fields: {
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'Unique identifier for this connected account',
    },
    createdAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'The date on which the ConnectedAccount was created',
    },
    updatedAt: {
      type: new GraphQLNonNull(GraphQLDateTime),
      description: 'The date on which the ConnectedAccount was last updated',
    },
    settings: { type: GraphQLJSON },
    service: { type: new GraphQLNonNull(ConnectedAccountService) },
  },
});
