import DataLoader from 'dataloader';
import ACTIVITY from '../../constants/activities';
import models, { Op } from '../../models';
import { ExpenseItem } from '../../models/ExpenseItem';
import { sortResultsArray } from './helpers';
import { ExpenseAttachedFile } from '../../models/ExpenseAttachedFile';

/**
 * Loader for expense's items.
 */
export const generateExpenseItemsLoader = (): DataLoader<number, ExpenseItem[]> => {
  return new DataLoader(async (expenseIds: number[]) => {
    const items = await models.ExpenseItem.findAll({
      where: { ExpenseId: { [Op.in]: expenseIds } },
    });

    return sortResultsArray(expenseIds, items, item => item.ExpenseId);
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
            ACTIVITY.COLLECTIVE_EXPENSE_UNAPPROVED,
            ACTIVITY.COLLECTIVE_EXPENSE_PAID,
            ACTIVITY.COLLECTIVE_EXPENSE_MARKED_AS_UNPAID,
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

/**
 * Loader for expense's attachedFiles.
 */
export const attachedFiles = (): DataLoader<number, ExpenseAttachedFile[]> => {
  return new DataLoader(async (expenseIds: number[]) => {
    const attachedFiles = await models.ExpenseAttachedFile.findAll({
      where: { ExpenseId: { [Op.in]: expenseIds } },
    });

    return sortResultsArray(expenseIds, attachedFiles, file => file.ExpenseId);
  });
};
