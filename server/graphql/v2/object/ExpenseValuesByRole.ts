import { GraphQLNonNull, GraphQLObjectType } from 'graphql';
import { GraphQLNonEmptyString } from 'graphql-scalars';

import { Expense } from '../../../models';
import { ExpenseDataValuesRoleDetails } from '../../../models/Expense';
import { getIdEncodeResolver, IDENTIFIER_TYPES } from '../identifiers';

import { GraphQLAccountingCategory } from './AccountingCategory';

const GraphQLExpenseValuesRoleDetails = new GraphQLObjectType({
  name: 'ExpenseValuesRoleDetails',
  fields: () => ({
    accountingCategory: {
      type: GraphQLAccountingCategory,
      resolve: async (data: ExpenseDataValuesRoleDetails, _, req) => {
        // Try to load the accounting category from the DB, fallback to the value stored in data (in case it was deleted)
        if (data?.accountingCategory?.id) {
          const category = await req.loaders.AccountingCategory.byId.load(data.accountingCategory.id);
          return category || data.accountingCategory;
        }
      },
    },
  }),
});

export const GraphQLExpenseValuesByRole = new GraphQLObjectType({
  name: 'ExpenseValuesByRole',
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLNonEmptyString), resolve: getIdEncodeResolver(IDENTIFIER_TYPES.EXPENSE) },
    submitter: {
      type: GraphQLExpenseValuesRoleDetails,
      description: 'The values provided by the expense submitter(s)',
      resolve: (expense: Expense) => expense.data?.valuesByRole?.submitter,
    },
    accountAdmin: {
      type: GraphQLExpenseValuesRoleDetails,
      description: 'The values provided by the account admin(s)',
      resolve: (expense: Expense) => expense.data?.valuesByRole?.collectiveAdmin,
    },
    hostAdmin: {
      type: GraphQLExpenseValuesRoleDetails,
      description: 'The values provided by the host admin(s)',
      resolve: (expense: Expense) => expense.data?.valuesByRole?.hostAdmin,
    },
  }),
});
