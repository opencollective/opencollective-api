import { GraphQLInputFieldConfig, GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';

import GraphQLEmailAddress from '../scalar/EmailAddress';

import { GraphQLCaptchaInput, GraphQLCaptchaInputFields } from './CaptchaInput';
import { GraphQLLocationInput, GraphQLLocationInputFields } from './LocationInput';

export type GraphQLGuestInfoInputFields = {
  email: string;
  name?: string;
  legalName?: string;
  location?: GraphQLLocationInputFields;
  captcha?: GraphQLCaptchaInputFields;
};

export const GraphQLGuestInfoInput = new GraphQLInputObjectType({
  name: 'GuestInfoInput',
  description: 'Input type for guest contributions',
  fields: () =>
    ({
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
    }) satisfies Record<keyof GraphQLGuestInfoInputFields, GraphQLInputFieldConfig>,
});
