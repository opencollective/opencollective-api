import DataLoader from 'dataloader';
import type { Request } from 'express';
import { groupBy } from 'lodash';

import ACTIVITY from '../../constants/activities';
import { TransactionKind } from '../../constants/transaction-kind';
import queries from '../../lib/queries';
import { checkExpensesBatch } from '../../lib/security/expense';
import models, { Op, sequelize } from '../../models';
import { Activity } from '../../models/Activity';
import Expense from '../../models/Expense';
import { ExpenseAttachedFile } from '../../models/ExpenseAttachedFile';
import { ExpenseItem } from '../../models/ExpenseItem';
import { LEGAL_DOCUMENT_TYPE } from '../../models/LegalDocument';

import { sortResultsArray } from './helpers';

/**
 * Loader for expense's items.
 */
export const generateExpenseItemsLoader = (): DataLoader<number, ExpenseItem[]> => {
  return new DataLoader(async (expenseIds: number[]) => {
    const items = await models.ExpenseItem.findAll({
      where: { ExpenseId: { [Op.in]: expenseIds } },
      order: [['id', 'ASC']],
    });

    return sortResultsArray(expenseIds, items, item => item.ExpenseId);
  });
};

/**
 * Load all activities for an expense
 */
export const generateExpenseActivitiesLoader = (): DataLoader<number, Activity[]> => {
  return new DataLoader(async (expenseIDs: number[]) => {
    const activities = await models.Activity.findAll({
      order: [['createdAt', 'ASC']],
      where: {
        ExpenseId: {
          [Op.in]: expenseIDs,
        },
        type: {
          [Op.in]: [
            ACTIVITY.COLLECTIVE_EXPENSE_CREATED,
            ACTIVITY.COLLECTIVE_EXPENSE_DELETED,
            ACTIVITY.COLLECTIVE_EXPENSE_UPDATED,
            ACTIVITY.COLLECTIVE_EXPENSE_INVITE_DRAFTED,
            ACTIVITY.COLLECTIVE_EXPENSE_REJECTED,
            ACTIVITY.COLLECTIVE_EXPENSE_APPROVED,
            ACTIVITY.COLLECTIVE_EXPENSE_MOVED,
            ACTIVITY.COLLECTIVE_EXPENSE_UNAPPROVED,
            ACTIVITY.COLLECTIVE_EXPENSE_PAID,
            ACTIVITY.COLLECTIVE_EXPENSE_MARKED_AS_UNPAID,
            ACTIVITY.COLLECTIVE_EXPENSE_PROCESSING,
            ACTIVITY.COLLECTIVE_EXPENSE_ERROR,
            ACTIVITY.COLLECTIVE_EXPENSE_SCHEDULED_FOR_PAYMENT,
            ACTIVITY.COLLECTIVE_EXPENSE_MARKED_AS_SPAM,
            ACTIVITY.COLLECTIVE_EXPENSE_MARKED_AS_INCOMPLETE,
          ],
        },
      },
    });

    return sortResultsArray(expenseIDs, activities, activity => activity.ExpenseId);
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

/**
 * Expense loader to check if userTaxForm is required before expense payment
 */
export const userTaxFormRequiredBeforePayment = (): DataLoader<number, boolean> => {
  return new DataLoader<number, boolean>(async (expenseIds: number[]): Promise<boolean[]> => {
    const expenseIdsPendingTaxForm = await queries.getTaxFormsRequiredForExpenses(expenseIds);
    return expenseIds.map(id => expenseIdsPendingTaxForm.has(id));
  });
};

/**
 * Loader for expense's requiredLegalDocuments.
 */
export const requiredLegalDocuments = (): DataLoader<number, string[]> => {
  return new DataLoader(async (expenseIds: number[]) => {
    const expenseIdsPendingTaxForm = await queries.getTaxFormsRequiredForExpenses(expenseIds);
    return expenseIds.map(id => (expenseIdsPendingTaxForm.has(id) ? [LEGAL_DOCUMENT_TYPE.US_TAX_FORM] : []));
  });
};

/**
 * Should only be used with paid expenses
 */
export const generateExpenseToHostTransactionFxRateLoader = (): DataLoader<
  number,
  { rate: number; currency: string }
> =>
  new DataLoader(async (expenseIds: number[]) => {
    const transactions = await models.Transaction.findAll({
      raw: true,
      attributes: ['ExpenseId', 'currency', [sequelize.json('data.expenseToHostFxRate'), 'expenseToHostFxRate']],
      where: {
        ExpenseId: expenseIds,
        kind: TransactionKind.EXPENSE,
        type: 'CREDIT',
        isRefund: false,
        RefundTransactionId: null,
        data: { expenseToHostFxRate: { [Op.ne]: null } },
      },
    });

    const groupedTransactions = groupBy(transactions, 'ExpenseId');
    return expenseIds.map(expenseId => {
      const transactionData = groupedTransactions[expenseId]?.[0];
      const rate = parseFloat(transactionData?.expenseToHostFxRate);
      return isNaN(rate) ? null : { rate, currency: transactionData?.currency };
    });
  });

export const populateAssociations = async <M>(
  req: Request,
  objects: M[],
  associations: Array<{ fkField: string; toProperty?: string; modelName: keyof typeof models }>,
): Promise<M[]> => {
  const promises = associations.map(async ({ fkField, toProperty, modelName }) => {
    const ids = objects.map(obj => obj[fkField]).filter(id => id);
    const foreignObjects = await req.loaders[modelName].byId.loadMany(ids);
    objects.forEach(obj => {
      const subObject = foreignObjects.find(s => s.id === obj[fkField]);
      if (subObject) {
        obj[toProperty || modelName] = subObject;
      }
    });
  });
  await Promise.all(promises);
  return objects;
};

export const generateExpensesSecurityCheckLoader = req => {
  return new DataLoader(
    async (expenses: Expense[]) => {
      await populateAssociations(req, expenses, [
        { fkField: 'CollectiveId', toProperty: 'collective', modelName: 'Collective' },
        { fkField: 'FromCollectiveId', toProperty: 'fromCollective', modelName: 'Collective' },
        { fkField: 'UserId', modelName: 'User' },
        { fkField: 'PayoutMethodId', modelName: 'PayoutMethod' },
      ]);

      return checkExpensesBatch(req, expenses);
    },
    {
      cacheKeyFn: (expense: Expense) => expense.id,
    },
  );
};
