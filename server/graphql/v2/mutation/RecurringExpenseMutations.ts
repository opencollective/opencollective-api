import express from 'express';
import { GraphQLBoolean, GraphQLNonNull } from 'graphql';

import expenseStatus from '../../../constants/expense_status';
import models from '../../../models';
import { NotFound, Unauthorized } from '../../errors';
import { idDecode, IDENTIFIER_TYPES } from '../identifiers';
import { RecurringExpenseReferenceInput } from '../input/RecurringExpenseReferenceInput';

const recurringExpenseMutations = {
  cancelRecurringExpense: {
    verifyExpense: {
      type: new GraphQLNonNull(GraphQLBoolean),
      description: 'To verify and unverified expense.',
      args: {
        recurringExpense: {
          type: new GraphQLNonNull(RecurringExpenseReferenceInput),
          description: 'Reference of the expense to process',
        },
      },
      async resolve(_: void, args, req: express.Request): Promise<boolean> {
        if (!req.remoteUser) {
          throw new Unauthorized();
        }

        const id = idDecode(args.recurringExpense.id, IDENTIFIER_TYPES.RECURRING_EXPENSE);
        const recurringExpense = await models.RecurringExpense.findByPk(id);
        if (!recurringExpense) {
          throw new NotFound();
        }
        if (![recurringExpense.CollectiveId, recurringExpense.FromCollectiveId].some(req.remoteUser.isAdmin)) {
          throw new Unauthorized(
            'User must be admin of payee or the collective the expense was previously submitted to',
          );
        }

        await recurringExpense.destroy();
        await models.Expense.destroy({
          where: {
            status: expenseStatus.DRAFT,
            RecurringExpenseId: recurringExpense.id,
          },
        });
        return true;
      },
    },
  },
};

export default recurringExpenseMutations;
