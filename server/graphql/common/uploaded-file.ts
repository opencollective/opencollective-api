import { Request } from 'express';

import { Collective, Expense, ExpenseAttachedFile, ExpenseItem, UploadedFile } from '../../models';

import { canSeeExpenseAttachments } from './expenses';

export async function hasUploadedFilePermission(req: Request, uploadedFile: UploadedFile): Promise<boolean> {
  const actualUrl = uploadedFile.getDataValue('url');
  switch (uploadedFile.kind) {
    case 'EXPENSE_ITEM': {
      const expenseItem = await ExpenseItem.findOne({
        where: {
          url: actualUrl,
        },
        include: { model: Expense, include: [{ association: 'fromCollective' }] },
      });

      const expense = expenseItem?.Expense;

      if (!expense) {
        return req.remoteUser?.id === uploadedFile.CreatedByUserId;
      }

      if (await canSeeExpenseAttachments(req, expense)) {
        return true;
      }
      break;
    }
    case 'EXPENSE_ATTACHED_FILE': {
      const expenseAttachedFile = await ExpenseAttachedFile.findOne({
        where: {
          url: actualUrl,
        },
        include: { model: Expense, include: [{ model: Collective, as: 'fromCollective' }] },
      });

      const expense = expenseAttachedFile?.Expense;

      if (!expense) {
        return req.remoteUser?.id === uploadedFile.CreatedByUserId;
      }

      if (await canSeeExpenseAttachments(req, expense)) {
        return true;
      }

      break;
    }
  }

  return false;
}
