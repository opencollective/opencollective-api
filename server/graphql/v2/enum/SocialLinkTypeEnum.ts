import { GraphQLEnumType } from 'graphql';

import { SocialLinkType } from '../../../models/SocialLink';

export const GraphQLSocialLinkTypeEnum = new GraphQLEnumType({
  name: 'SocialLinkType',
  description: 'The type of social link',
  values: Object.keys(SocialLinkType).reduce((acc, key) => {
    return {
      ...acc,
      [key]: {
        value: SocialLinkType[key],
      },
    };
  }, {}),
});
