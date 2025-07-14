import type Express from 'express';

import { Expense, sequelize, UploadedFile } from '../../models';
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

  let expense = options.expenseId && (await Expense.findByPk(options.expenseId));

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

  const result = await sequelize.query(
    `
    SELECT * FROM (
      (
        SELECT "ExpenseId"
        FROM "ExpenseItems" where url = :url
        AND "deletedAt" IS NULL LIMIT 1
      )
      UNION ALL
      (
        SELECT id as "ExpenseId"
        FROM "Expenses" where "InvoiceFileId" = :invoiceFileId
        AND "deletedAt" IS NULL LIMIT 1
      )
      UNION ALL
      (
        SELECT "ExpenseId"
        FROM "ExpenseAttachedFiles" where url = :url
      )
    ) LIMIT 1
  `,
    {
      type: sequelize.QueryTypes.SELECT,
      raw: true,
      replacements: {
        url: actualUrl,
        invoiceFileId: uploadedFile.id,
      },
    },
  );

  const expenseId = result?.[0]?.ExpenseId;
  if (!expenseId) {
    return req.remoteUser?.id === uploadedFile.CreatedByUserId;
  }

  expense = await Expense.findByPk(expenseId, {
    include: { association: 'fromCollective' },
  });

  return canSeeExpenseAttachments(req, expense);
}
