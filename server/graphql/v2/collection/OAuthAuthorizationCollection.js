import { GraphQLList, GraphQLObjectType } from 'graphql';

import { CollectionFields, GraphQLCollection } from '../interface/Collection.js';
import { GraphQLOAuthAuthorization } from '../object/OAuthAuthorization.js';

export const GraphQLOAuthAuthorizationCollection = new GraphQLObjectType({
  name: 'OAuthAuthorizationCollection',
  interfaces: [GraphQLCollection],
  description: 'A collection of "OAuth Authorizations"',
  fields: () => {
    return {
      ...CollectionFields,
      nodes: {
        type: new GraphQLList(GraphQLOAuthAuthorization),
      },
    };
  },
});
