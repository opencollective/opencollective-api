import DataLoader from 'dataloader';

import ACTIVITY from '../../constants/activities';
import models, { Op, sequelize } from '../../models';
import { ExpenseAttachedFile } from '../../models/ExpenseAttachedFile';
import { ExpenseItem } from '../../models/ExpenseItem';
import { LEGAL_DOCUMENT_TYPE } from '../../models/LegalDocument';

import { sortResultsArray } from './helpers';

const THRESHOLD = 600e2;
const {
  requestStatus: { RECEIVED },
} = models.LegalDocument;

const userTaxFormRequiredBeforePaymentQuery = `
  SELECT 
    e."UserId" "userId", 
    MAX(er.id) as "expenseId",
    MAX(ld."requestStatus") as "legalDocRequestStatus",
    MAX(d."documentType") as "requiredDocument",
    SUM (e."amount") AS total
  FROM "Expenses" e
  INNER JOIN "Expenses" er ON e."UserId" = er."UserId"
  INNER JOIN "Collectives" c ON c.id = e."CollectiveId"
  INNER JOIN "RequiredLegalDocuments" d ON d."HostCollectiveId" = c."HostCollectiveId"
                                    AND d."documentType" = 'US_TAX_FORM'
  LEFT JOIN "LegalDocuments" ld ON ld."CollectiveId" = e."FromCollectiveId"
                                AND ld.year = date_part('year', e."incurredAt")
                                AND ld."documentType" = 'US_TAX_FORM'
  WHERE er.id IN (:expenseIds)
  AND e.type = 'INVOICE'
  AND er.type = 'INVOICE'
  AND e.status IN ('PENDING', 'APPROVED', 'PAID', 'PROCESSING', 'SCHEDULED_FOR_PAYMENT')
  AND e.type NOT IN ('RECEIPT')
  AND e."deletedAt" IS NULL
  AND e."incurredAt" BETWEEN date_trunc('year', e."incurredAt") AND (date_trunc('year', e."incurredAt") + interval '1 year')
  GROUP BY e."UserId"
`;

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

/**
 * Expense loader to check if userTaxForm is required before expense payment
 */
export const userTaxFormRequiredBeforePayment = (): DataLoader<number, boolean> => {
  return new DataLoader(async (expenseIds: number[]) => {
    const expenses = await sequelize.query(userTaxFormRequiredBeforePaymentQuery, {
      type: sequelize.QueryTypes.SELECT,
      raw: true,
      model: models.Expense,
      replacements: { expenseIds },
    });
    const expenseNeedsTaxForm = {};
    expenses.forEach(expense => {
      expenseNeedsTaxForm[expense.expenseId] =
        expense.requiredDocument && expense.total >= THRESHOLD && expense.legalDocRequestStatus !== RECEIVED;
    });
    return expenseIds.map(id => expenseNeedsTaxForm[id] || false);
  });
};

/**
 * Loader for expense's requiredLegalDocuments.
 */
export const requiredLegalDocuments = (): DataLoader<number, string[]> => {
  return new DataLoader(async (expenseIds: number[]) => {
    const expenses = await sequelize.query(userTaxFormRequiredBeforePaymentQuery, {
      type: sequelize.QueryTypes.SELECT,
      raw: true,
      model: models.Expense,
      replacements: { expenseIds },
    });

    const expenseNeedsTaxForm = {};

    expenses.forEach(expense => {
      expenseNeedsTaxForm[expense.expenseId] =
        expense.requiredDocument && expense.total >= THRESHOLD && expense.legalDocRequestStatus !== RECEIVED;
    });

    return expenseIds.map(id => (expenseNeedsTaxForm[id] ? [LEGAL_DOCUMENT_TYPE.US_TAX_FORM] : []));
  });
};
