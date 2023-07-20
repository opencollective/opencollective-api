import { GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';

import GraphQLEmailAddress from '../scalar/EmailAddress.js';

import { GraphQLCaptchaInput } from './CaptchaInput.js';
import { GraphQLLocationInput } from './LocationInput.js';

export const GraphQLGuestInfoInput = new GraphQLInputObjectType({
  name: 'GuestInfoInput',
  description: 'Input type for guest contributions',
  fields: () => ({
    email: {
      type: new GraphQLNonNull(GraphQLEmailAddress),
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
      type: GraphQLLocationInput,
      description: 'Address of the user, mandatory when amount is above $5000.',
    },
    captcha: {
      type: GraphQLCaptchaInput,
      description: 'Captcha validation for creating an order',
    },
  }),
});
