import { GraphQLInt, GraphQLNonNull, GraphQLString } from 'graphql';
import { pick } from 'lodash';

import rawQueries from '../../../../lib/queries';
import { TagStatsCollection } from '../../collection/TagStatsCollection';

const TagStatsCollectionQuery = {
  type: new GraphQLNonNull(TagStatsCollection),
  args: {
    searchTerm: {
      type: GraphQLString,
      description: 'Return tags from collectives which includes this search term',
    },
    limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 10 },
    offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
  },
  async resolve(_, args) {
    const tagFrequencies = await rawQueries.getTagFrequencies({
      ...pick(args, ['searchTerm', 'limit', 'offset']),
    });

    return { nodes: tagFrequencies, limit: args.limit, offset: args.offset };
  },
};

export default TagStatsCollectionQuery;
