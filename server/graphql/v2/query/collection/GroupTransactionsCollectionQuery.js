import { GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

import { groupCollectivesTransactions } from '../../../../lib/budget';
import { TransactionKind } from '../../enum/TransactionKind';
import { TransactionType } from '../../enum/TransactionType';
import { AccountReferenceInput, fetchAccountsWithReferences } from '../../input/AccountReferenceInput';
import { Account } from '../../interface/Account';
import { Collection, CollectionFields } from '../../interface/Collection';
import { Amount } from '../../object/Amount';

export const GroupTransactions = new GraphQLObjectType({
  name: 'GroupTransactions',
  fields: () => ({
    account: {
      type: new GraphQLNonNull(Account),
      resolve(result, _, req) {
        return req.loaders.Collective.byId.load(result.CollectiveId);
      },
    },
    oppositeAccount: {
      type: new GraphQLNonNull(Account),
      resolve(result, _, req) {
        return req.loaders.Collective.byId.load(result.FromCollectiveId);
      },
    },
    amount: {
      type: new GraphQLNonNull(Amount),
      resolve(result) {
        return { value: result.value, currency: result.currency };
      },
    },
  }),
});

export const GroupTransactionsCollection = new GraphQLObjectType({
  name: 'GroupTransactionsCollection',
  interfaces: [Collection],
  fields: () => {
    return {
      ...CollectionFields,
      nodes: {
        type: new GraphQLList(GroupTransactions),
      },
    };
  },
});

const GroupTransactionsCollectionQuery = {
  type: new GraphQLNonNull(GroupTransactionsCollection),
  args: {
    account: {
      type: new GraphQLList(new GraphQLNonNull(AccountReferenceInput)),
      description:
        'Reference of the account(s) assigned to the main side of the transaction (CREDIT -> recipient, DEBIT -> sender)',
    },
    type: {
      type: TransactionType,
      description: 'The transaction type (DEBIT or CREDIT)',
    },
    kind: {
      type: new GraphQLList(TransactionKind),
      description: 'To filter by transaction kind',
    },
    dateFrom: {
      type: GraphQLDateTime,
      description: 'Only return transactions that were created after this date',
    },
    dateTo: {
      type: GraphQLDateTime,
      description: 'Only return transactions that were created before this date',
    },
    limit: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 10 },
    offset: { type: new GraphQLNonNull(GraphQLInt), defaultValue: 0 },
  },
  async resolve(_, args) {
    const column = 'netAmountInCollectiveCurrency';

    const options = { column, includeGiftCards: true };
    if (args.type) {
      options.transactionType = args.type;
    }
    if (args.kind) {
      options.kind = args.kind;
    }
    if (args.dateFrom) {
      options.startDate = args.dateFrom;
    }
    if (args.dateTo) {
      options.endDate = args.dateTo;
    }

    let collectiveIds = null;
    if (args.account) {
      const accounts = await fetchAccountsWithReferences(args.account);
      collectiveIds = accounts.map(account => account.id);
    }

    const results = await groupCollectivesTransactions(collectiveIds, options);

    return { nodes: Object.values(results), limit: args.limit, offset: args.offset };
  },
};

export default GroupTransactionsCollectionQuery;
