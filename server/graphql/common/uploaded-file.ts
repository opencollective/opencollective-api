import type Express from 'express';

import { Collective, Expense, ExpenseAttachedFile, ExpenseItem, UploadedFile } from '../../models';
import { ExpenseStatus } from '../../models/Expense';
import { idDecode, IDENTIFIER_TYPES } from '../v2/identifiers';

import { canSeeExpenseAttachments, canSeeExpenseDraftPrivateDetails } from './expenses';

export async function hasProtectedUrlPermission(req: Express.Request, url: string) {
  const requestedUrl = new URL(url);
  const encodedExpenseId = requestedUrl.searchParams.get('expenseId');
  const draftKey = requestedUrl.searchParams.get('draftKey');
  requestedUrl.hash = '';
  requestedUrl.search = '';

  const protectedUrl = requestedUrl.toString();

  const uploadedFile = await UploadedFile.getFromProtectedURL(protectedUrl);

  if (!uploadedFile) {
    return false;
  }

  let expenseId: number;
  if (encodedExpenseId) {
    expenseId = idDecode(encodedExpenseId, IDENTIFIER_TYPES.EXPENSE);
  }

  return hasUploadedFilePermission(req, uploadedFile, {
    expenseId,
    draftKey,
  });
}

export async function hasUploadedFilePermission(
  req: Express.Request,
  uploadedFile: UploadedFile,
  options?: { expenseId: number; draftKey?: string },
): Promise<boolean> {
  const actualUrl = uploadedFile.getDataValue('url');

  const expense = options.expenseId && (await Expense.findByPk(options.expenseId));

  if (expense && expense.status === ExpenseStatus.DRAFT) {
    const itemMatches = ((expense.data?.items as { url?: string }[]) || []).some(
      item => item.url && item.url === actualUrl,
    );
    const attachedFileMatches = ((expense.data?.attachedFiles as { url?: string }[]) || []).some(
      item => item.url && item.url === actualUrl,
    );
    const invoiceFileMatches = (expense.data?.invoiceFile as { url: string })?.url === actualUrl;

    const fileIsInDraft = itemMatches || attachedFileMatches || invoiceFileMatches;

    if (fileIsInDraft && (await canSeeExpenseDraftPrivateDetails(req, expense))) {
      return true;
    }

    if (fileIsInDraft && options.draftKey && expense.data.draftKey === options.draftKey) {
      return true;
    }
  }

  if (!req?.remoteUser) {
    return false;
  }

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
    case 'EXPENSE_INVOICE': {
      const expense = await Expense.findOne({
        where: {
          InvoiceFileId: uploadedFile.id,
        },
        include: [{ association: 'fromCollective' }],
      });

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
