import { GraphQLInputObjectType, GraphQLString } from 'graphql';
import { GraphQLJSONObject } from 'graphql-scalars';

import { GraphQLVirtualCardProvider } from '../enum/VirtualCardProvider.js';

export const GraphQLVirtualCardInput = new GraphQLInputObjectType({
  name: 'VirtualCardInput',
  fields: () => ({
    id: { type: GraphQLString },
    name: { type: GraphQLString },
    last4: { type: GraphQLString },
    data: { type: GraphQLJSONObject },
    privateData: { type: GraphQLJSONObject },
    provider: { type: GraphQLVirtualCardProvider },
  }),
});
