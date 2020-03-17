import { GraphQLString, GraphQLInputObjectType } from 'graphql';
import GraphQLJSON from 'graphql-type-json';
import { ConnectedAccountService } from '../enum/ConnectedAccountService';

/**
 * An input for ConnectedAccount that can be used for either editing or creating.
 */
const ConnectedAccountCreateInput = new GraphQLInputObjectType({
  name: 'ConnectedAccountCreateInput',
  fields: {
    clientId: { type: GraphQLString },
    data: { type: GraphQLJSON },
    id: { type: GraphQLString },
    refreshToken: { type: GraphQLString },
    settings: { type: GraphQLJSON },
    token: { type: GraphQLString },
    service: { type: ConnectedAccountService },
    username: { type: GraphQLString },
  },
});

export { ConnectedAccountCreateInput };
