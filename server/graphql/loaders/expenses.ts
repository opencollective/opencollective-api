import DataLoader from 'dataloader';
import moment from 'moment';

import ACTIVITY from '../../constants/activities';
import { isUserTaxFormRequiredBeforePayment } from '../../lib/tax-forms';
import models, { Op, sequelize } from '../../models';
import { ExpenseAttachedFile } from '../../models/ExpenseAttachedFile';
import { ExpenseItem } from '../../models/ExpenseItem';
import { LEGAL_DOCUMENT_TYPE } from '../../models/LegalDocument';

import { sortResultsArray, sortResultsSimple } from './helpers';

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

/**
 * Expense loader to check if userTaxForm is required before expense payment
 */
export const userTaxFormRequiredBeforePayment = (req): DataLoader<number, boolean> => {
  return new DataLoader(async (expenseIds: number[]) => {
    const results = await sequelize.query(`
      SELECT e.id "expenseId", e."UserId" "userId", ld."requestStatus" "legalDocRequestStatus", d."documentType" "requiredDocument",
        SUM (amount) AS total
      FROM "Expenses" e
      INNER JOIN "Collectives" c ON c.id = e."CollectiveId"
      LEFT JOIN "RequiredLegalDocuments" d ON d."HostCollectiveId" = c."HostCollectiveId"
                                              AND d."documentType" = 'US_TAX_FORM'
      LEFT JOIN "LegalDocuments" ld ON ld."CollectiveId" = e."FromCollectiveId"
                                        AND ld.year = date_part('year', e."incurredAt")
                                        AND ld."documentType" = 'US_TAX_FORM'
      WHERE e.status IN ('PENDING', 'APPROVED', 'PAID', 'PROCESSING')
      AND e."UserId" IN (SELECT "UserId" FROM "Expenses" WHERE "Expenses".id IN (:expenseIds))
      AND e.type NOT IN ('RECEIPT')
      AND "incurredAt" BETWEEN e."incurredAt" AND (e."incurredAt" + interval '1 year')
      GROUP BY e.id, e."UserId", d."documentType", ld."requestStatus"
    `, {
       type: sequelize.QueryTypes.SELECT,
       model: models.Expense,
       mapToModel: true,
       replacements: { expenseIds }
    });

    const expenses =  results.map((result) => {
      const expense = result.dataValues
      const data = { expenseId: expense.expenseId, userTaxFormRequiredBeforePayment: false }

      if (!expense.requiredDocument) {
        data.userTaxFormRequiredBeforePayment = false
        return data;
      }

      if (expense.total >= THRESHOLD) {
        data.userTaxFormRequiredBeforePayment = true;
        return data;
      }

      // Check if the user has completed document
      if (expense.legalDocRequestStatus && expense.legalDocRequestStatus === RECEIVED) {
        data.userTaxFormRequiredBeforePayment = false;
        return data;
      }
      return data;
    })
    
    return sortResultsSimple(expenseIds, expenses, expense => expense.expenseId)
    .map((expense: []) => expense.userTaxFormRequiredBeforePayment)
  });
}

/**
 * Loader for expense's requiredLegalDocuments.
 */
export const requiredLegalDocuments = (req): DataLoader<number, object[]> => {
  return new DataLoader(async (expenseIds: number[]) => {
    const expenses = await req.loaders.Expense.byId.loadMany(expenseIds);
     return Promise.all(
       expenses.map(async expense => {
        const incurredYear = moment(expense.incurredAt).year();
        const isW9FormRequired = await isUserTaxFormRequiredBeforePayment({
          year: incurredYear,
          invoiceTotalThreshold: 600e2,
          expenseCollectiveId: expense.CollectiveId,
          UserId: expense.UserId,
        });

        return isW9FormRequired ? [LEGAL_DOCUMENT_TYPE.US_TAX_FORM] : [];
       })
     )
  });
}
