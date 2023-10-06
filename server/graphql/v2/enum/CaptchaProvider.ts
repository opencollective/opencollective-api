import { GraphQLEnumType } from 'graphql';

export const GraphQLCaptchaProvider = new GraphQLEnumType({
  name: 'CaptchaProvider',
  description: 'Implemented Captcha Providers',
  values: {
    HCAPTCHA: {},
    RECAPTCHA: {},
  },
});
