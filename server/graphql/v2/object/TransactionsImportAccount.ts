import { GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { GraphQLNonEmptyString } from 'graphql-scalars';

import { GraphQLAccountingCategory } from './AccountingCategory';

export const GraphQLTransactionsImportAccount = new GraphQLObjectType({
  name: 'TransactionsImportAccount',
  description: 'An account available in a transactions import (Plaid or GoCardless)',
  fields: () => ({
    id: {
      type: new GraphQLNonNull(GraphQLNonEmptyString),
      description: 'The unique identifier for the account',
    },
    name: {
      type: new GraphQLNonNull(GraphQLNonEmptyString),
      description: 'The name of the account',
    },
    // Plaid-specific fields
    subtype: {
      type: GraphQLString,
      description: 'The subtype of the account (Plaid only)',
    },
    type: {
      type: GraphQLString,
      description: 'The type of the account (Plaid only)',
    },
    mask: {
      type: GraphQLString,
      description: 'The mask of the account (Plaid only)',
    },
    balanceAccountingCategory: {
      type: GraphQLAccountingCategory,
      description:
        'The balance/clearing accounting category used to attribute activity matched from this bank sub-account (only visible to host admins)',
      resolve: (account, _, req) => {
        if (!account.BalanceAccountingCategoryId || !req.remoteUser?.isAdmin(account.CollectiveId)) {
          return null;
        }
        return req.loaders.AccountingCategory.byId.load(account.BalanceAccountingCategoryId);
      },
    },
  }),
});
