import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { SocialLinkTypeEnum } from '../enum/SocialLinkTypeEnum';

export const SocialLink = new GraphQLObjectType({
  name: 'SocialLink',
  description: 'A social link',
  fields: () => ({
    type: {
      type: new GraphQLNonNull(SocialLinkTypeEnum),
    },
    url: {
      type: new GraphQLNonNull(GraphQLString),
    },
    createdAt: { type: GraphQLDateTime },
    updatedAt: { type: GraphQLDateTime },
  }),
});
