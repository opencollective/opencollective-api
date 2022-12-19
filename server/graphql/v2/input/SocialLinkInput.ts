import { GraphQLInputObjectType, GraphQLNonNull } from 'graphql';
import { GraphQLNonEmptyString } from 'graphql-scalars';

import { SocialLinkTypeEnum } from '../enum/SocialLinkTypeEnum';

export const SocialLinkInput = new GraphQLInputObjectType({
  name: 'SocialLinkInput',
  fields: () => ({
    type: {
      type: new GraphQLNonNull(SocialLinkTypeEnum),
    },
    url: {
      type: GraphQLNonEmptyString,
    },
  }),
});
