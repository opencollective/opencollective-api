import { GraphQLInputObjectType, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLJSON } from 'graphql-scalars';

import { GraphQLSocialLinkInput } from './SocialLinkInput';

export const GraphQLProjectCreateInput = new GraphQLInputObjectType({
  name: 'ProjectCreateInput',
  fields: () => ({
    name: { type: new GraphQLNonNull(GraphQLString) },
    slug: { type: new GraphQLNonNull(GraphQLString) },
    description: { type: new GraphQLNonNull(GraphQLString) },
    tags: { type: new GraphQLList(GraphQLString) },
    settings: { type: GraphQLJSON },
    socialLinks: {
      type: new GraphQLList(new GraphQLNonNull(GraphQLSocialLinkInput)),
      description: 'The social links in order of preference',
    },
  }),
});
