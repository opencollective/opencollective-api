import { GraphQLError, GraphQLInt, GraphQLNonNull, GraphQLString } from 'graphql';
import { pick } from 'lodash';

import { getExpenseTagFrequencies } from '../../../../lib/sql-search';
import { GraphQLTagStatsCollection } from '../../collection/TagStatsCollection';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../../input/AccountReferenceInput';

const ExpenseTagStatsCollectionQuery = {
  type: new GraphQLNonNull(GraphQLTagStatsCollection),
  args: {
    tagSearchTerm: {
      type: GraphQLString,
      description: 'Return tags which includes this search term.',
    },
    host: {
      type: GraphQLAccountReferenceInput,
      description:
        'Return tags from expenses to accounts hosted by this account. Can not be used together with "account".',
    },
    account: {
      type: GraphQLAccountReferenceInput,
      description: 'Return tags from expenses to this account. Can not be used together with "host".',
    },
    limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 10 },
    offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
  },
  async resolve(_, args) {
    let hostCollectiveId, accountId;
    if (args.host) {
      const host = await fetchAccountWithReference(args.host, { throwIfMissing: true });
      hostCollectiveId = host.id;
    }
    if (args.account) {
      const account = await fetchAccountWithReference(args.account, { throwIfMissing: true });
      accountId = account.id;
    }
    if (!args.account && !args.host) {
      throw new GraphQLError('You must provide either a host or an account');
    }
    if (args.account && args.host) {
      throw new GraphQLError('You must provide either a host or an account, not both');
    }
    const tagFrequencies = await getExpenseTagFrequencies({
      ...pick(args, ['tagSearchTerm', 'limit', 'offset']),
      hostCollectiveId,
      accountId,
    });

    return { nodes: tagFrequencies, limit: args.limit, offset: args.offset };
  },
};

export default ExpenseTagStatsCollectionQuery;
