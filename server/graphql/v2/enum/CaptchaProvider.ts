import { GraphQLEnumType } from 'graphql';

import CaptchaProviders from '../../../constants/captcha-providers';

export const GraphQLCaptchaProvider = new GraphQLEnumType({
  name: 'CaptchaProvider',
  description: 'Implemented Captcha Providers',
  values: Object.values(CaptchaProviders).reduce((values, key) => {
    return { ...values, [key]: { value: key } };
  }, {}),
});
