import express from 'express';
import { GraphQLError, GraphQLInt, GraphQLNonNull, GraphQLString } from 'graphql';
import { pick } from 'lodash';

import { assertCanSeeAccount } from '../../../../lib/private-accounts';
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
  async resolve(_, args, req: express.Request) {
    let hostCollectiveId, accountId;

    if (!args.account && !args.host) {
      throw new GraphQLError('You must provide either a host or an account');
    } else if (args.account && args.host) {
      throw new GraphQLError('You must provide either a host or an account, not both');
    } else if (args.host) {
      const host = await fetchAccountWithReference(args.host, { throwIfMissing: true });
      await assertCanSeeAccount(req, host);
      hostCollectiveId = host.id;
    } else if (args.account) {
      const account = await fetchAccountWithReference(args.account, { throwIfMissing: true });
      await assertCanSeeAccount(req, account);
      accountId = account.id;
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
