import { GraphQLString } from 'graphql';

import expenseStatus from '../../../constants/expense-status';
import { allowContextPermission, PERMISSION_TYPE } from '../../common/context-permissions';
import { fetchExpenseWithReference, GraphQLExpenseReferenceInput } from '../input/ExpenseReferenceInput';
import { GraphQLExpense } from '../object/Expense';

const ExpenseQuery = {
  type: GraphQLExpense,
  args: {
    id: {
      type: GraphQLString,
      description: 'Public expense identifier',
      deprecationReason: '2020-02-28: Please use the `expense` field.',
    },
    expense: {
      type: GraphQLExpenseReferenceInput,
      description: 'Identifiers to retrieve the expense.',
    },
    draftKey: {
      type: GraphQLString,
      description: 'Submit-on-behalf key to access drafted Expenses',
    },
  },
  async resolve(_, args, req) {
    let expense;
    if (args.expense) {
      expense = await fetchExpenseWithReference(args.expense, req);
    } else if (args.id) {
      expense = await req.loaders.Expense.byId.load(args.id);
    } else {
      throw new Error('You must either provide an id or an expense');
    }

    if (!expense) {
      return null;
    } else if (args.draftKey && expense.status === expenseStatus.DRAFT) {
      if (expense.data?.draftKey !== args.draftKey) {
        return null;
      } else {
        allowContextPermission(req, PERMISSION_TYPE.SEE_EXPENSE_DRAFT_PRIVATE_DETAILS, expense.id);
        if (expense.PayoutMethodId) {
          allowContextPermission(req, PERMISSION_TYPE.SEE_PAYOUT_METHOD_DETAILS, expense.PayoutMethodId);
        }
      }
    }

    return expense;
  },
};

export default ExpenseQuery;
