import type Express from 'express';
import { QueryTypes } from 'sequelize';

import { EntityShortIdPrefix, isEntityPublicId } from '../../lib/permalink/entity-map';
import { Expense, sequelize, UploadedFile } from '../../models';
import { ExpenseStatus } from '../../models/Expense';
import ExportRequest from '../../models/ExportRequest';
import { idDecode, IDENTIFIER_TYPES } from '../v2/identifiers';

import { canSeeExpenseAttachments, canSeeExpenseDraftPrivateDetails } from './expenses';
import { canUseExportRequestsForAccount } from './export-requests';

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
  if (isEntityPublicId(encodedExpenseId, EntityShortIdPrefix.Expense)) {
    expenseId = await req.loaders.Expense.idByPublicId.load(encodedExpenseId);
    if (!expenseId) {
      return false;
    }
  } else if (encodedExpenseId) {
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

  if (uploadedFile.kind === 'TRANSACTIONS_CSV_EXPORT') {
    // One-to-one relationship enforced by a unique index constraint.
    const exportRequest = await ExportRequest.findOne({
      where: {
        UploadedFileId: uploadedFile.id,
      },
    });
    if (!exportRequest) {
      return false;
    }

    const account = await req.loaders.Collective.byId.load(exportRequest.CollectiveId);
    return canUseExportRequestsForAccount(req.remoteUser, account);
  }

  // A file may (historically) be referenced by more than one expense. Collect all of them and fail closed:
  // the user must be allowed to see the attachments of every live expense that references the file.
  const rows = await sequelize.query<{ ExpenseId: number }>(
    `
    SELECT e.id AS "ExpenseId"
    FROM "Expenses" e
    INNER JOIN (
      SELECT "ExpenseId" FROM "ExpenseItems" WHERE url = :url AND "deletedAt" IS NULL
      UNION
      SELECT id AS "ExpenseId" FROM "Expenses" WHERE "InvoiceFileId" = :invoiceFileId
      UNION
      SELECT "ExpenseId" FROM "ExpenseAttachedFiles" WHERE url = :url
    ) refs ON refs."ExpenseId" = e.id
    WHERE e."deletedAt" IS NULL
  `,
    {
      type: QueryTypes.SELECT,
      raw: true,
      replacements: {
        url: actualUrl,
        invoiceFileId: uploadedFile.id,
      },
    },
  );

  if (!rows.length) {
    return req.remoteUser?.id === uploadedFile.CreatedByUserId;
  }

  const expenses = await Expense.findAll({
    where: { id: rows.map(row => row.ExpenseId) },
    include: { association: 'fromCollective' },
  });

  for (const linkedExpense of expenses) {
    if (!(await canSeeExpenseAttachments(req, linkedExpense))) {
      return false;
    }
  }

  return true;
}
