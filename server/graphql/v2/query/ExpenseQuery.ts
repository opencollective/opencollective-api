import { GraphQLString } from 'graphql';

import expenseStatus from '../../../constants/expense_status';
import { allowContextPermission, PERMISSION_TYPE } from '../../common/context-permissions';
import { fetchExpenseWithReference, GraphQLExpenseReferenceInput } from '../input/ExpenseReferenceInput';
import GraphQLExpense from '../object/Expense';

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

    if (
      !expense ||
      (expense.status === expenseStatus.DRAFT && args.draftKey && expense.data?.draftKey !== args.draftKey)
    ) {
      return null;
    } else if (expense.status === expenseStatus.DRAFT && args.draftKey && expense.data?.draftKey === args.draftKey) {
      allowContextPermission(req, PERMISSION_TYPE.SEE_EXPENSE_DRAFT_PRIVATE_DETAILS, expense.id);
    }

    return expense;
  },
};

export default ExpenseQuery;
