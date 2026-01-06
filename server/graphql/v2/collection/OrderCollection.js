import { GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';

import { GraphQLAccountCollection } from '../collection/AccountCollection';
import { CollectionArgs, CollectionFields, GraphQLCollection } from '../interface/Collection';
import { GraphQLOrder } from '../object/Order';

export const GraphQLOrderCollection = new GraphQLObjectType({
  name: 'OrderCollection',
  interfaces: [GraphQLCollection],
  description: 'A collection of "Orders"',
  fields: () => {
    return {
      ...CollectionFields,
      nodes: {
        type: new GraphQLList(GraphQLOrder),
      },
      createdByUsers: {
        type: new GraphQLNonNull(GraphQLAccountCollection),
        description:
          'The accounts that created the orders in this collection (respecting the `account`, `host`, `hostContext`, `includeChildrenAccounts`, `expectedFundsFilter` and `status` arguments), regardless of pagination. Returns a paginated and searchable collection.',
        args: {
          ...CollectionArgs,
          searchTerm: {
            type: GraphQLString,
            description: 'Search term to filter by name, slug, or email',
          },
        },
      },
    };
  },
});
