import { GraphQLList, GraphQLString } from 'graphql';

import { searchCollectivesInDB } from '../../../../lib/sql-search';
import { GraphQLHostCollection } from '../../collection/HostCollection';
import { ORDER_BY_PSEUDO_FIELDS } from '../../enum/OrderByFieldType';
import { CollectionArgs } from '../../interface/Collection';

import { CommonAccountsCollectionQueryArgs } from './AccountsCollectionQuery';

const HostsCollectionQuery = {
  type: GraphQLHostCollection,
  args: {
    ...CollectionArgs,
    ...CommonAccountsCollectionQueryArgs,
    currency: {
      type: GraphQLString,
    },
    tags: {
      type: new GraphQLList(GraphQLString),
      description: 'Filter hosts by tags (multiple = OR)',
      deprecationReason: '2020-06-30: Please use tag (singular)',
    },
  },
  async resolve(_, args) {
    const searchParams = {
      orderBy: { field: ORDER_BY_PSEUDO_FIELDS.HOST_RANK, direction: 'DESC' },
      isHost: true,
      onlyOpenHosts: true,
      onlyActive: args.isActive ? true : null,
      skipRecentAccounts: args.skipRecentAccounts,
      countries: args.country,
      tags: args.tag ?? args.tags,
      tagSearchOperator: args.tagSearchOperator,
      includeArchived: args.includeArchived,
      currency: args.currency,
    };

    const cleanTerm = args.searchTerm?.trim();
    const [accounts, totalCount] = await searchCollectivesInDB(cleanTerm, args.offset, args.limit, searchParams);

    return { nodes: accounts, totalCount, limit: args.limit, offset: args.offset };
  },
};

export default HostsCollectionQuery;
