import { GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';

import { GraphQLApplicationType } from '../enum';
import URL from '../scalar/URL';

import { GraphQLAccountReferenceInput } from './AccountReferenceInput';

export const GraphQLApplicationCreateInput = new GraphQLInputObjectType({
  name: 'ApplicationCreateInput',
  description: 'Input type for Application',
  fields: () => ({
    type: { type: new GraphQLNonNull(GraphQLApplicationType), defaultValue: 'oAuth' },
    name: { type: GraphQLString },
    description: { type: GraphQLString },
    redirectUri: { type: URL },
    account: {
      type: GraphQLAccountReferenceInput,
      description: 'The account to use as the owner of the application. Defaults to currently logged in user.',
    },
  }),
});
