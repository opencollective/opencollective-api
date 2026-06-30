import { GraphQLInputFieldConfig, GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';

import CaptchaProviders from '../../../constants/captcha-providers';
import { GraphQLCaptchaProvider } from '../enum/CaptchaProvider';

export type GraphQLCaptchaInputFields = {
  token: string;
  provider: CaptchaProviders;
};

export const GraphQLCaptchaInput = new GraphQLInputObjectType({
  name: 'CaptchaInput',
  description: 'Captcha related information',
  fields: () =>
    ({
      token: {
        type: new GraphQLNonNull(GraphQLString),
        description: 'Captcha validation token',
      },
      provider: {
        type: new GraphQLNonNull(GraphQLCaptchaProvider),
        description: 'Catpcha provider',
      },
    }) satisfies Record<keyof GraphQLCaptchaInputFields, GraphQLInputFieldConfig>,
});
