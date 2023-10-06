import { GraphQLList, GraphQLObjectType } from 'graphql';

import { CollectionFields, GraphQLCollection } from '../interface/Collection';
import { GraphQLOAuthAuthorization } from '../object/OAuthAuthorization';

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
