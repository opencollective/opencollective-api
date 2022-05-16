import { GraphQLInputObjectType, GraphQLString } from 'graphql';

import { ApplicationReferenceFields } from '../input/ApplicationReferenceInput';
import URL from '../scalar/URL';

export const ApplicationUpdateInput = new GraphQLInputObjectType({
  name: 'ApplicationUpdateInput',
  description: 'Input type for Application',
  fields: () => ({
    ...ApplicationReferenceFields,
    name: { type: GraphQLString },
    description: { type: GraphQLString },
    callbackUrl: { type: URL },
  }),
});
