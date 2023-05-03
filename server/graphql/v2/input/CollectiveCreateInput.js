import { GraphQLInputObjectType, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLJSON } from 'graphql-scalars';

import { LocationInput } from './LocationInput';

export const CollectiveCreateInput = new GraphQLInputObjectType({
  name: 'CollectiveCreateInput',
  fields: () => ({
    name: { type: new GraphQLNonNull(GraphQLString) },
    slug: { type: new GraphQLNonNull(GraphQLString) },
    description: { type: new GraphQLNonNull(GraphQLString) },
    tags: { type: new GraphQLList(GraphQLString) },
    location: { type: LocationInput },
    githubHandle: { type: GraphQLString, deprecationReason: '2022-06-03: Please use repositoryUrl' },
    repositoryUrl: { type: GraphQLString, deprecationReason: '2023-01-16: Please use socialLinks' },
    settings: { type: GraphQLJSON },
  }),
});
