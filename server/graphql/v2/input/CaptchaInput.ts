import { GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';

import { GraphQLCaptchaProvider } from '../enum/CaptchaProvider.js';

export const GraphQLCaptchaInput = new GraphQLInputObjectType({
  name: 'CaptchaInput',
  description: 'Captcha related information',
  fields: () => ({
    token: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'Captcha validation token',
    },
    provider: {
      type: new GraphQLNonNull(GraphQLCaptchaProvider),
      description: 'Catpcha provider',
    },
  }),
});
