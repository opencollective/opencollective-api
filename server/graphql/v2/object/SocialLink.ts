import { GraphQLNonNull, GraphQLObjectType } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { GraphQLSocialLinkTypeEnum } from '../enum/SocialLinkTypeEnum';
import URL from '../scalar/URL';

export const GraphQLSocialLink = new GraphQLObjectType({
  name: 'SocialLink',
  description: 'A social link',
  fields: () => ({
    type: {
      type: new GraphQLNonNull(GraphQLSocialLinkTypeEnum),
    },
    url: {
      type: new GraphQLNonNull(URL),
    },
    createdAt: { type: GraphQLDateTime },
    updatedAt: { type: GraphQLDateTime },
  }),
});
