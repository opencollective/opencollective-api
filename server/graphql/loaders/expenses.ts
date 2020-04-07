import DataLoader from 'dataloader';
import ACTIVITY from '../../constants/activities';
import models, { Op } from '../../models';
import { ExpenseAttachment } from '../../models/ExpenseAttachment';
import { sortResultsArray } from './helpers';

/**
 * Loader for expense's attachments.
 */
export const generateExpenseAttachmentsLoader = (): DataLoader<number, ExpenseAttachment[]> => {
  return new DataLoader(async (expenseIds: number[]) => {
    const attachments = await models.ExpenseAttachment.findAll({
      where: { ExpenseId: { [Op.in]: expenseIds } },
    });

    return sortResultsArray(expenseIds, attachments, attachment => attachment.ExpenseId);
  });
};

/**
 * Load all activities for an expense
 */
export const generateExpenseActivitiesLoader = (req): DataLoader<number, object> => {
  return new DataLoader(async (expenseIDs: number[]) => {
    // Optimization: load expenses to get their collective IDs, as filtering on `data` (JSON)
    // can be expensive.
    const expenses = await req.loaders.Expense.byId.loadMany(expenseIDs);
    const collectiveIds = expenses.map(expense => expense.CollectiveId);
    const activities = await models.Activity.findAll({
      order: [['createdAt', 'ASC']],
      where: {
        CollectiveId: {
          [Op.in]: collectiveIds,
        },
        type: {
          [Op.in]: [
            ACTIVITY.COLLECTIVE_EXPENSE_CREATED,
            ACTIVITY.COLLECTIVE_EXPENSE_DELETED,
            ACTIVITY.COLLECTIVE_EXPENSE_UPDATED,
            ACTIVITY.COLLECTIVE_EXPENSE_REJECTED,
            ACTIVITY.COLLECTIVE_EXPENSE_APPROVED,
            ACTIVITY.COLLECTIVE_EXPENSE_PAID,
            ACTIVITY.COLLECTIVE_EXPENSE_PROCESSING,
            ACTIVITY.COLLECTIVE_EXPENSE_ERROR,
          ],
        },
        data: {
          expense: {
            id: {
              [Op.in]: expenseIDs,
            },
          },
        },
      },
    });

    return sortResultsArray(expenseIDs, activities, activity => activity.data.expense.id);
  });
};
