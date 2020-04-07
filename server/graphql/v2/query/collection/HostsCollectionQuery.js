import { GraphQLList, GraphQLString } from 'graphql';
import { pick } from 'lodash';

import rawQueries from '../../../../lib/queries';

import { CollectionArgs } from '../../interface/Collection';
import { AccountCollection } from '../../collection/AccountCollection';

const HostsCollectionQuery = {
  type: AccountCollection,
  args: {
    ...CollectionArgs,
    tags: {
      type: new GraphQLList(GraphQLString),
      description: 'Filter hosts by tags (multiple = OR)',
    },
  },
  async resolve(_, args) {
    const { collectives, total } = await rawQueries.getHosts({
      ...pick(args, ['limit', 'offset', 'tags']),
      onlyOpenHosts: true,
      minNbCollectivesHosted: 1,
      orderBy: 'collectives',
      orderDirection: 'DESC',
    });

    return { nodes: collectives, totalCount: total, limit: args.limit, offset: args.offset };
  },
};

export default HostsCollectionQuery;
