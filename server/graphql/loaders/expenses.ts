import DataLoader from 'dataloader';
import { Collection, groupBy, partition, zip } from 'lodash';

import { roles } from '../../constants';
import ACTIVITY from '../../constants/activities';
import { SupportedCurrency } from '../../constants/currencies';
import { TransactionKind } from '../../constants/transaction-kind';
import queries from '../../lib/queries';
import { checkExpensesBatch } from '../../lib/security/expense';
import models, { Collective, LegalDocument, Op, sequelize } from '../../models';
import Activity from '../../models/Activity';
import Expense from '../../models/Expense';
import ExpenseAttachedFile from '../../models/ExpenseAttachedFile';
import ExpenseItem from '../../models/ExpenseItem';

import { populateModelAssociations, sortResultsArray } from './helpers';

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
            ACTIVITY.COLLECTIVE_EXPENSE_RE_APPROVAL_REQUESTED,
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
            ACTIVITY.COLLECTIVE_EXPENSE_PUT_ON_HOLD,
            ACTIVITY.COLLECTIVE_EXPENSE_RELEASED_FROM_HOLD,
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
export const taxFormRequiredBeforePayment = (): DataLoader<number, boolean> => {
  return new DataLoader<number, boolean>(async (expenseIds: number[]): Promise<boolean[]> => {
    const expenseIdsPendingTaxForm = await queries.getTaxFormsRequiredForExpenses(expenseIds);
    return expenseIds.map(id => expenseIdsPendingTaxForm.has(id));
  });
};

export const generateExpenseTaxFormsLoader = (req): DataLoader<Expense, LegalDocument[]> => {
  return new DataLoader(async (expenses: Expense[]) => {
    if (!req.remoteUser) {
      return expenses.map(() => null);
    }

    // Separate expenses that have a HostCollectiveId from those that don't to conditionally load the host
    const [expensesWithHostId, expensesWithoutHostId] = partition(expenses, e => e.HostCollectiveId);

    // Load all hosts
    const [expensesWithHostIdHosts, expensesWithoutHostIdHosts] = await Promise.all([
      req.loaders.Collective.byId.loadMany(expensesWithHostId.map(e => e.HostCollectiveId)),
      req.loaders.Collective.hostByCollectiveId.loadMany(expensesWithoutHostId.map(e => e.CollectiveId)),
    ]);

    // Zip the expenses with their hosts
    const expensesWithHosts: Array<{ host: Collective; expense: Expense }> = [
      ...zip(expensesWithHostId, expensesWithHostIdHosts),
      ...zip(expensesWithoutHostId, expensesWithoutHostIdHosts),
    ].map(([expense, host]) => ({ expense, host }));

    const expensesWhereIsHostAdmin = expensesWithHosts
      .filter(({ host }) => req.remoteUser.hasRole([roles.ADMIN, roles.ACCOUNTANT], host.id))
      .map(({ expense }) => expense);

    if (expensesWhereIsHostAdmin.length === 0) {
      return expenses.map(() => []);
    }

    const expenseIdsWithTaxForm = await queries.getTaxFormsRequiredForExpenses(
      expensesWhereIsHostAdmin.map(e => e.id),
      { ignoreReceived: false },
    );
    // TODO
  });
};

/**
 * Should only be used with paid expenses
 */
export const generateExpenseToHostTransactionFxRateLoader = (): DataLoader<
  number,
  { rate: number; currency: SupportedCurrency }
> =>
  new DataLoader(async (expenseIds: number[]) => {
    const transactions = (await models.Transaction.findAll({
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
    })) as unknown as [
      {
        ExpenseId: number;
        currency: SupportedCurrency;
        expenseToHostFxRate: string;
      },
    ];

    const groupedTransactions = groupBy(transactions, 'ExpenseId');
    return expenseIds.map(expenseId => {
      const transactionData = groupedTransactions[expenseId]?.[0];
      const rate = parseFloat(transactionData?.expenseToHostFxRate);
      return isNaN(rate) ? null : { rate, currency: transactionData?.currency };
    });
  });

export const generateExpensesSecurityCheckLoader = req => {
  return new DataLoader(
    async (expenses: Expense[]) => {
      await populateModelAssociations(req, expenses, [
        { fkField: 'CollectiveId', as: 'collective', modelName: 'Collective' },
        { fkField: 'FromCollectiveId', as: 'fromCollective', modelName: 'Collective' },
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
