import { GraphQLNonNull } from 'graphql';
import { pick } from 'lodash';

import rawQueries from '../../../../lib/queries';
import { TagStatsCollection } from '../../collection/TagStatsCollection';

const TagFrequencyQuery = {
  type: new GraphQLNonNull(TagStatsCollection),
  async resolve(_, args) {
    const tagFrequencies = await rawQueries.getTagFrequencies({
      ...pick(args, ['limit', 'offset']),
    });

    return { nodes: tagFrequencies, limit: args.limit, offset: args.offset };
  },
};

export default TagFrequencyQuery;
