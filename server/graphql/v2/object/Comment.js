import { GraphQLString, GraphQLObjectType } from 'graphql';
import { GraphQLDateTime } from 'graphql-iso-date';
import { Account } from '../interface/Account';
import { getIdEncodeResolver } from '../identifiers';
import { collectiveResolver, fromCollectiveResolver, getStripTagsResolver } from '../../common/comment';

const Comment = new GraphQLObjectType({
  name: 'Comment',
  description: 'This represents an Comment',
  fields: () => {
    return {
      id: {
        type: GraphQLString,
        resolve: getIdEncodeResolver('comment'),
      },
      createdAt: {
        type: GraphQLDateTime,
      },
      html: {
        type: GraphQLString,
      },
      markdown: {
        type: GraphQLString,
        resolve: getStripTagsResolver('markdown'),
      },
      fromAccount: {
        type: Account,
        resolve: fromCollectiveResolver,
      },
      account: {
        type: Account,
        resolve: collectiveResolver,
      },
      // Deprecated
      fromCollective: {
        type: Account,
        resolve: fromCollectiveResolver,
        deprecationReason: '2020-02-25: Please use fromAccount',
      },
      collective: {
        type: Account,
        resolve: collectiveResolver,
        deprecationReason: '2020-02-25: Please use fromAccount',
      },
    };
  },
});

export { Comment };
