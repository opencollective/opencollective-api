import { GraphQLString, GraphQLInputObjectType } from 'graphql';
import GraphQLJSON from 'graphql-type-json';
import { ConnectedAccountService } from '../enum/ConnectedAccountService';

/**
 * An input for ConnectedAccount that can be used for either editing or creating.
 */
const ConnectedAccountCreateInput = new GraphQLInputObjectType({
  name: 'ConnectedAccountCreateInput',
  fields: {
    clientId: {
      type: GraphQLString,
      description: 'Optional Client ID for the token or secret',
    },
    data: {
      type: GraphQLJSON,
      description: 'Private data related to the connected account',
    },
    refreshToken: {
      type: GraphQLString,
      description: 'Refresh token for the connected account',
    },
    settings: {
      type: GraphQLJSON,
      description: 'Public data related to the connected account',
    },
    token: {
      type: GraphQLString,
      description: 'Secret token used to call service',
    },
    service: {
      type: ConnectedAccountService,
      description: 'Service which the connected account belongs to',
    },
    username: {
      type: GraphQLString,
      description: 'Optional username for the connected account',
    },
  },
});

export { ConnectedAccountCreateInput };
