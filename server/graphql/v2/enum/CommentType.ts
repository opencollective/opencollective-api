import { GraphQLEnumType } from 'graphql';

import { CommentType as CommentTypeEnum } from '../../../models/Comment';

export const GraphQLCommentType = new GraphQLEnumType({
  name: 'CommentType',
  description: 'All supported comment contexts',
  values: {
    [CommentTypeEnum.COMMENT]: {
      description: 'Default regular comment',
    },
    [CommentTypeEnum.PRIVATE_NOTE]: {
      description: 'Comment is visible only to host admins',
    },
  },
});
