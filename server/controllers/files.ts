import config from 'config';
import { Request, Response } from 'express';

import { canSeeExpenseAttachments } from '../graphql/common/expenses';
import { idDecode, IDENTIFIER_TYPES } from '../graphql/v2/identifiers';
import { getSignedGetURL, parseS3Url } from '../lib/awsS3';
import { Collective, Expense, ExpenseAttachedFile, ExpenseItem, UploadedFile } from '../models';
import { SUPPORTED_FILE_TYPES_IMAGES } from '../models/UploadedFile';

async function hasUploadedFilePermission(req: Request, uploadedFile: UploadedFile): Promise<boolean> {
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

      if (expense && (await canSeeExpenseAttachments(req, expense))) {
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

      if (expense && (await canSeeExpenseAttachments(req, expense))) {
        return true;
      }

      break;
    }
  }

  return false;
}

/**
 * GET /api/files/:uploadedFileId
 *
 * Query Params
 *
 * json - return json response
 * thumbnail - return thumbnail json
 */
export async function getFile(req: Request, res: Response) {
  res.set('Cache-Control', 'private');

  if (!req.remoteUser) {
    return res.status(401).send({ message: 'Authentication Required' });
  }

  const isJsonAccepted = req.query.json !== undefined;
  const isThumbnail = req.query.thumbnail !== undefined;

  const { uploadedFileId } = req.params;

  let decodedId: number;
  try {
    decodedId = idDecode(uploadedFileId, IDENTIFIER_TYPES.UPLOADED_FILE);
  } catch (err) {
    return res.status(400).send({ message: 'Invalid id' });
  }

  const uploadedFile = await UploadedFile.findOne({
    where: {
      id: decodedId,
    },
  });

  if (!uploadedFile) {
    return res.status(403).send({ message: 'Unauthorized' });
  }

  const actualUrl = uploadedFile.getDataValue('url');

  if (!(await hasUploadedFilePermission(req, uploadedFile))) {
    return res.status(403).send({ message: 'Unauthorized' });
  }

  let redirectUrl: string;

  if (isThumbnail) {
    if (SUPPORTED_FILE_TYPES_IMAGES.includes(uploadedFile.fileType as (typeof SUPPORTED_FILE_TYPES_IMAGES)[number])) {
      redirectUrl = `${config.host.website}/static/images/camera.png`;
    } else {
      redirectUrl = `${config.host.website}/static/images/mime-pdf.png`;
    }
  } else {
    if (!UploadedFile.isOpenCollectiveS3BucketURL(actualUrl)) {
      redirectUrl = actualUrl;
    } else {
      const { bucket, key } = parseS3Url(actualUrl);
      redirectUrl = await getSignedGetURL({ Bucket: bucket, Key: key }, { expiresIn: 3600 });
    }
  }

  if (isJsonAccepted) {
    return res.send({ url: redirectUrl });
  } else {
    return res.redirect(307, redirectUrl);
  }
}
