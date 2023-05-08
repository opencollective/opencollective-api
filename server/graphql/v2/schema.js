import { GraphQLObjectType, GraphQLSchema } from 'graphql';

import mutation from './mutation';
import query from './query';
import types from './types';

const Query = new GraphQLObjectType({
  name: 'Query',
  description: 'This is the root query',
  fields: () => {
    return query;
  },
});

// TODO(ESM): Move this to standard ESM imports once available and remove the promise
export default new Promise(resolve => {
  mutation.then(mutations => {
    resolve(
      new GraphQLSchema({
        types: types,
        query: Query,
        mutation: new GraphQLObjectType({
          name: 'Mutation',
          description: 'This is the root mutation',
          fields: () => {
            return mutations;
          },
        }),
      }),
    );
  });
});
