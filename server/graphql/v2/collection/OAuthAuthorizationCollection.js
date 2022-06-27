import { GraphQLList, GraphQLObjectType } from 'graphql';

import { Collection, CollectionFields } from '../interface/Collection';
import { OAuthAuthorization } from '../object/OAuthAuthorization';

const OAuthAuthorizationCollection = new GraphQLObjectType({
  name: 'OAuthAuthorizationCollection',
  interfaces: [Collection],
  description: 'A collection of "OAuth Authorizations"',
  fields: () => {
    return {
      ...CollectionFields,
      nodes: {
        type: new GraphQLList(OAuthAuthorization),
      },
    };
  },
});

export { OAuthAuthorizationCollection };
