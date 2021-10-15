import { GraphQLString } from 'graphql';

import expenseStatus from '../../../constants/expense_status';
import { allowContextPermission, PERMISSION_TYPE } from '../../common/context-permissions';
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
      if (!expense) {
        return null;
      }

      // Special case for draft expenses
      if (expense.status === expenseStatus.DRAFT) {
        if (expense.data?.draftKey !== args.draftKey && !req.remoteUser?.isAdmin(expense.FromCollectiveId)) {
          // Not an admin / no valid draft key => no access
          return null;
        } else if (expense.PayoutMethodId) {
          // Can see the payout method data if owner of the expense or draftKey is valid
          allowContextPermission(req, PERMISSION_TYPE.SEE_PAYOUT_METHOD_DATA, expense.PayoutMethodId);
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
