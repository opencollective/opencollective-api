import { GraphQLInputObjectType, GraphQLNonNull } from 'graphql';

import { SocialLinkTypeEnum } from '../enum/SocialLinkTypeEnum';
import URL from '../scalar/URL';

export const SocialLinkInput = new GraphQLInputObjectType({
  name: 'SocialLinkInput',
  fields: () => ({
    type: {
      type: new GraphQLNonNull(SocialLinkTypeEnum),
    },
    url: {
      type: new GraphQLNonNull(URL),
    },
  }),
});
