import { GraphQLInputObjectType, GraphQLNonNull } from 'graphql';

import { GraphQLSocialLinkTypeEnum } from '../enum/SocialLinkTypeEnum.js';
import URL from '../scalar/URL.js';

export const GraphQLSocialLinkInput = new GraphQLInputObjectType({
  name: 'SocialLinkInput',
  fields: () => ({
    type: {
      type: new GraphQLNonNull(GraphQLSocialLinkTypeEnum),
    },
    url: {
      type: new GraphQLNonNull(URL),
    },
  }),
});
