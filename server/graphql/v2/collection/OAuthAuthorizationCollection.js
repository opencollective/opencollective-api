import { GraphQLList, GraphQLObjectType } from 'graphql';

import { Collection, CollectionFields } from '../interface/Collection';
import { OauthAuthorization } from '../object/OauthAuthorization';

const OauthAuthorizationCollection = new GraphQLObjectType({
  name: 'OauthAuthorizationCollection',
  interfaces: [Collection],
  description: 'A collection of "oAuth Authorizations"',
  fields: () => {
    return {
      ...CollectionFields,
      nodes: {
        type: new GraphQLList(OauthAuthorization),
      },
    };
  },
});

export { OauthAuthorizationCollection };
