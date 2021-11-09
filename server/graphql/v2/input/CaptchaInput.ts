import { GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';

import { CaptchaProvider } from '../enum/CaptchaProvider';

export const CaptchaInput = new GraphQLInputObjectType({
  name: 'CaptchaInput',
  description: 'Captcha related information',
  fields: () => ({
    token: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'Captcha validation token',
    },
    provider: {
      type: new GraphQLNonNull(CaptchaProvider),
      description: 'Catpcha provider',
    },
  }),
});
