import { GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';

import { ApplicationType } from '../enum';
import URL from '../scalar/URL';

export const ApplicationCreateInput = new GraphQLInputObjectType({
  name: 'ApplicationCreateInput',
  description: 'Input type for Application',
  fields: () => ({
    type: { type: new GraphQLNonNull(ApplicationType), defaultValue: 'oAuth' },
    name: { type: GraphQLString },
    description: { type: GraphQLString },
    callbackUrl: { type: URL },
  }),
});
