import { GraphQLEnumType } from 'graphql';

export const CaptchaProvider = new GraphQLEnumType({
  name: 'CaptchaProvider',
  description: 'Implemented Captcha Providers',
  values: {
    HCAPTCHA: {},
    RECAPTCHA: {},
  },
});
