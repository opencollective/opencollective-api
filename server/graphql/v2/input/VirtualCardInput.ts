import { GraphQLInputObjectType, GraphQLString } from 'graphql';
import { GraphQLJSONObject } from 'graphql-scalars';

import { VirtualCard } from '../../../models';
import { GraphQLVirtualCardProvider } from '../enum/VirtualCardProvider';

export const GraphQLVirtualCardInput = new GraphQLInputObjectType({
  name: 'VirtualCardInput',
  fields: () => ({
    id: { type: GraphQLString, deprecationReason: '2026-02-25: use publicId' },
    publicId: { type: GraphQLString, description: `The resource public id (ie: ${VirtualCard.nanoIdPrefix}_xxxxxxxx)` },
    name: { type: GraphQLString },
    last4: { type: GraphQLString },
    data: { type: GraphQLJSONObject },
    privateData: { type: GraphQLJSONObject },
    provider: { type: GraphQLVirtualCardProvider },
  }),
});
