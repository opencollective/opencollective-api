import { GraphQLInputObjectType, GraphQLString } from 'graphql';

import { ApplicationReferenceFields } from '../input/ApplicationReferenceInput.js';
import URL from '../scalar/URL.js';

export const GraphQLApplicationUpdateInput = new GraphQLInputObjectType({
  name: 'ApplicationUpdateInput',
  description: 'Input type for Application',
  fields: () => ({
    ...ApplicationReferenceFields,
    name: { type: GraphQLString },
    description: { type: GraphQLString },
    redirectUri: { type: URL },
  }),
});
