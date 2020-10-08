import { GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';

import EmailAddress from '../scalar/EmailAddress';

export const GuestInfoInput = new GraphQLInputObjectType({
  name: 'GuestInfoInput',
  description: 'Input type for guest contributions',
  fields: {
    email: {
      type: GraphQLNonNull(EmailAddress),
      description: "Contributor's email",
    },
    name: {
      type: GraphQLString,
      description: 'Full name of the user',
    },
    token: {
      type: GraphQLString,
      description: 'The unique guest token',
    },
  },
});
