import { GraphQLNonNull, GraphQLObjectType } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { SocialLinkTypeEnum } from '../enum/SocialLinkTypeEnum';
import URL from '../scalar/URL';

export const SocialLink = new GraphQLObjectType({
  name: 'SocialLink',
  description: 'A social link',
  fields: () => ({
    type: {
      type: new GraphQLNonNull(SocialLinkTypeEnum),
    },
    url: {
      type: new GraphQLNonNull(URL),
    },
    createdAt: { type: GraphQLDateTime },
    updatedAt: { type: GraphQLDateTime },
  }),
});
