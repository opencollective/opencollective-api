import { GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';

import { Account } from '../interface/Account';
import { Collection, CollectionFields } from '../interface/Collection';
import { AccountCollectionStats } from '../object/AccountCollectionStats';

const AccountCollection = new GraphQLObjectType({
  name: 'AccountCollection',
  interfaces: [Collection],
  description: 'A collection of "Accounts"',
  fields: () => {
    return {
      ...CollectionFields,
      nodes: {
        type: new GraphQLList(Account),
      },
      stats: {
        type: new GraphQLNonNull(AccountCollectionStats),
        description: 'Stats for the returned results (i.e. accounts within the limit)',
        resolve(collection) {
          return collection;
        },
      },
    };
  },
});

export { AccountCollection };
