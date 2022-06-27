import { GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';

import { ApplicationType } from '../enum';
import URL from '../scalar/URL';

import { AccountReferenceInput } from './AccountReferenceInput';

export const ApplicationCreateInput = new GraphQLInputObjectType({
  name: 'ApplicationCreateInput',
  description: 'Input type for Application',
  fields: () => ({
    type: { type: new GraphQLNonNull(ApplicationType), defaultValue: 'oAuth' },
    name: { type: GraphQLString },
    description: { type: GraphQLString },
    redirectUri: { type: URL },
    account: {
      type: AccountReferenceInput,
      description: 'The account to use as the owner of the application. Defaults to currently logged in user.',
    },
  }),
});
