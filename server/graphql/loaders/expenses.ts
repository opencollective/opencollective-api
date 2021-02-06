import DataLoader from 'dataloader';

import ACTIVITY from '../../constants/activities';
import queries from '../../lib/queries';
import models, { Op } from '../../models';
import { ExpenseAttachedFile } from '../../models/ExpenseAttachedFile';
import { ExpenseItem } from '../../models/ExpenseItem';
import { LEGAL_DOCUMENT_TYPE } from '../../models/LegalDocument';

import { sortResultsArray } from './helpers';

const THRESHOLD = 600e2;
const {
  requestStatus: { RECEIVED },
} = models.LegalDocument;

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
        ExpenseId: {
          [Op.in]: expenseIDs,
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
            ACTIVITY.COLLECTIVE_EXPENSE_SCHEDULED_FOR_PAYMENT,
          ],
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

const loadTaxFormsRequiredForExpenses = async (expenseIds: number[]): Promise<object> => {
  const expenses = await queries.getTaxFormsRequiredForExpenses(expenseIds);
  const expenseNeedsTaxForm = {};
  expenses.forEach(expense => {
    expenseNeedsTaxForm[expense.expenseId] =
      expense.requiredDocument && expense.total >= THRESHOLD && expense.legalDocRequestStatus !== RECEIVED;
  });
  return expenseNeedsTaxForm;
};

/**
 * Expense loader to check if userTaxForm is required before expense payment
 */
export const userTaxFormRequiredBeforePayment = (): DataLoader<number, boolean> => {
  return new DataLoader(async (expenseIds: number[]) => {
    const expenseNeedsTaxForm = await loadTaxFormsRequiredForExpenses(expenseIds);
    return expenseIds.map(id => expenseNeedsTaxForm[id] || false);
  });
};

/**
 * Loader for expense's requiredLegalDocuments.
 */
export const requiredLegalDocuments = (): DataLoader<number, string[]> => {
  return new DataLoader(async (expenseIds: number[]) => {
    const expenseNeedsTaxForm = await loadTaxFormsRequiredForExpenses(expenseIds);
    return expenseIds.map(id => (expenseNeedsTaxForm[id] ? [LEGAL_DOCUMENT_TYPE.US_TAX_FORM] : []));
  });
};
