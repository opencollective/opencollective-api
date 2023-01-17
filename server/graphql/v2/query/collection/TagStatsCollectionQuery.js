import { GraphQLInt, GraphQLNonNull, GraphQLString } from 'graphql';
import { pick } from 'lodash';

import { getTagFrequencies } from '../../../../lib/search';
import { TagStatsCollection } from '../../collection/TagStatsCollection';

const TagStatsCollectionQuery = {
  type: new GraphQLNonNull(TagStatsCollection),
  args: {
    searchTerm: {
      type: GraphQLString,
      description:
        'Return tags from collectives which includes this search term. Using this argument will ignore tagSearchTerm. Skipping this argument will use a more efficient query.',
    },
    tagSearchTerm: {
      type: GraphQLString,
      description: 'Return tags which includes this search term. Using this argument will ignore searchTerm.',
    },
    limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 10 },
    offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
  },
  async resolve(_, args) {
    const tagFrequencies = await getTagFrequencies({
      ...pick(args, ['searchTerm', 'tagSearchTerm', 'limit', 'offset']),
    });

    return { nodes: tagFrequencies, limit: args.limit, offset: args.offset };
  },
};

export default TagStatsCollectionQuery;
