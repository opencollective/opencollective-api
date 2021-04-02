import { GraphQLInt, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-iso-date';
import { GraphQLJSONObject } from 'graphql-type-json';

export const VirtualCard = new GraphQLObjectType({
  name: 'VirtualCard',
  description: 'VirtualCard related properties.',
  fields: () => ({
    id: { type: GraphQLString },
    CollectiveId: { type: GraphQLInt },
    HostCollectiveId: { type: GraphQLInt },
    name: { type: GraphQLString },
    last4: { type: GraphQLString },
    data: { type: GraphQLJSONObject },
    privateData: { type: GraphQLJSONObject },
    createdAt: { type: GraphQLDateTime },
    updatedAt: { type: GraphQLDateTime },
    deletedAt: { type: GraphQLDateTime },
  }),
});
