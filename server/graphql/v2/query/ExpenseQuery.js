import { GraphQLString } from 'graphql';

import expenseStatus from '../../../constants/expense_status';
import { ExpenseReferenceInput, fetchExpenseWithReference } from '../input/ExpenseReferenceInput';
import { Expense } from '../object/Expense';

const ExpenseQuery = {
  type: Expense,
  args: {
    id: {
      type: GraphQLString,
      description: 'Public expense identifier',
      deprecationReason: '2020-02-28: Please use the `expense` field.',
    },
    expense: {
      type: ExpenseReferenceInput,
      description: 'Identifiers to retrieve the expense.',
    },
    draftKey: {
      type: GraphQLString,
      description: 'Submit-on-behalf key to access drafted Expenses',
    },
  },
  async resolve(_, args, req) {
    if (args.expense) {
      const expense = await fetchExpenseWithReference(args.expense, req);

      if (expense?.status === expenseStatus.DRAFT) {
        const canViewDraftExpense =
          expense.data?.draftKey === args.draftKey ||
          req.remoteUser?.isAdmin(expense.FromCollectiveId) ||
          req.remoteUser?.isAdminOfCollectiveOrHost(await expense.getCollective());

        if (!canViewDraftExpense) {
          return null;
        }
      }

      return expense;
    } else if (args.id) {
      return req.loaders.Expense.byId.load(args.id);
    } else {
      throw new Error('You must either provide an id or an expense');
    }
  },
};

export default ExpenseQuery;
