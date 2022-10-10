import { GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';

import EmailAddress from '../scalar/EmailAddress';

import { CaptchaInput } from './CaptchaInput';
import { LocationInput } from './LocationInput';

export const GuestInfoInput = new GraphQLInputObjectType({
  name: 'GuestInfoInput',
  description: 'Input type for guest contributions',
  fields: () => ({
    email: {
      type: new GraphQLNonNull(EmailAddress),
      description: "Contributor's email",
    },
    name: {
      type: GraphQLString,
      description: 'Display name of the user',
    },
    legalName: {
      type: GraphQLString,
      description: 'Legal name of the user',
    },
    location: {
      type: LocationInput,
      description: 'Address of the user, mandatory when amount is above $5000.',
    },
    captcha: {
      type: CaptchaInput,
      description: 'Captcha validation for creating an order',
    },
  }),
});
