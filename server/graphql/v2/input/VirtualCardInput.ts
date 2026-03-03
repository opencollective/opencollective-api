import { GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLJSONObject } from 'graphql-scalars';

import { EntityShortIdPrefix } from '../../../lib/permalink/entity-map';
import { GraphQLVirtualCardProvider } from '../enum/VirtualCardProvider';

export const GraphQLVirtualCardInput = new GraphQLInputObjectType({
  name: 'VirtualCardInput',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLString),
      description: `The public id identifying the virtual card (ie: ${EntityShortIdPrefix.VirtualCard}_xxxxxxxx)`,
    },
    name: { type: GraphQLString },
    last4: { type: GraphQLString },
    data: { type: GraphQLJSONObject },
    privateData: { type: GraphQLJSONObject },
    provider: { type: GraphQLVirtualCardProvider },
  }),
});
