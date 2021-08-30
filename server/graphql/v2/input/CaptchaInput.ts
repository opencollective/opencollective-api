import { GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';

import { CaptchaProvider } from '../enum/CaptchaProvider';

export const CaptchaInput = new GraphQLInputObjectType({
  name: 'CaptchaInput',
  description: 'Captcha related information',
  fields: () => ({
    token: {
      type: GraphQLNonNull(GraphQLString),
      description: 'Captcha validation token',
    },
    provider: {
      type: GraphQLNonNull(CaptchaProvider),
      description: 'Catpcha provider',
    },
  }),
});
