import { GraphQLInt, GraphQLNonNull, GraphQLString } from 'graphql';
import { pick } from 'lodash';

import { getColletiveTagFrequencies } from '../../../../lib/search';
import { GraphQLTagStatsCollection } from '../../collection/TagStatsCollection';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../../input/AccountReferenceInput';

const TagStatsCollectionQuery = {
  type: new GraphQLNonNull(GraphQLTagStatsCollection),
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
    host: {
      type: GraphQLAccountReferenceInput,
      description: 'Return tags from collectives hosted by this host.',
    },
    limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 10 },
    offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
  },
  async resolve(_, args) {
    let hostCollectiveId;
    if (args.host) {
      const host = await fetchAccountWithReference(args.host, { throwIfMissing: true });
      hostCollectiveId = host.id;
    }
    const tagFrequencies = await getColletiveTagFrequencies({
      ...pick(args, ['searchTerm', 'tagSearchTerm', 'limit', 'offset']),
      hostCollectiveId,
    });

    return { nodes: tagFrequencies, limit: args.limit, offset: args.offset };
  },
};

export default TagStatsCollectionQuery;
