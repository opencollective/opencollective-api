import { GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';

// import { pick } from 'lodash';
import { sumCollectivesTransactions } from '../../../../lib/budget';
// import { TagStatsCollection } from '../../collection/TagStatsCollection';
import { TransactionKind } from '../../enum/TransactionKind';
import { TransactionType } from '../../enum/TransactionType';
import { AccountReferenceInput, fetchAccountsWithReferences } from '../../input/AccountReferenceInput';
import { Account } from '../../interface/Account';
import { Collection, CollectionFields } from '../../interface/Collection';
// import { TagStats } from '../object/TagStats';
import { Amount } from '../../object/Amount';

export const SumTransactions = new GraphQLObjectType({
  name: 'SumTransactions',
  // description: 'Statistics for a given tag',
  fields: () => ({
    // id: {
    //   type: new GraphQLNonNull(GraphQLString),
    //   description: 'An unique identifier for this tag',
    // },
    account: {
      type: new GraphQLNonNull(Account),
      // description: 'The account where the expense was submitted',
      resolve(result, _, req) {
        return req.loaders.Collective.byId.load(result.CollectiveId);
      },
    },
    oppositeAccount: {
      type: new GraphQLNonNull(Account),
      // description: 'The account where the expense was submitted',
      resolve(result, _, req) {
        // console.log('oppositeAccount', result);
        return req.loaders.Collective.byId.load(result.FromCollectiveId);
      },
    },
    // co
    // count: {
    //   type: new GraphQLNonNull(GraphQLInt),
    //   description: 'Number of entries for this tag',
    // },
    amount: {
      type: new GraphQLNonNull(Amount),
      // description: 'Total amount for this tag',
      resolve(result) {
        // if (entry.amount) {
        return { value: result.value, currency: result.currency };
        // }
      },
    },
  }),
});

export const SumTransactionsCollection = new GraphQLObjectType({
  name: 'SumTransactionsCollection',
  interfaces: [Collection],
  // description: 'A collection of "Tags"',
  fields: () => {
    return {
      ...CollectionFields,
      nodes: {
        type: new GraphQLList(SumTransactions),
      },
    };
  },
});

const SumTransactionsCollectionQuery = {
  type: new GraphQLNonNull(SumTransactionsCollection),
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
    // searchTerm: {
    //   type: GraphQLString,
    //   description: 'Return tags from collectives which includes this search term',
    // },
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

    let collectiveIds = null;
    if (args.account) {
      const accounts = await fetchAccountsWithReferences(args.account);
      // const collectiveIds = await getCollectiveIds(collective, includeChildren);
      collectiveIds = accounts.map(account => account.id);
    }

    const results = await sumCollectivesTransactions(collectiveIds, options);

    // console.log(results);

    return { nodes: Object.values(results), limit: args.limit, offset: args.offset };
  },
};

export default SumTransactionsCollectionQuery;
