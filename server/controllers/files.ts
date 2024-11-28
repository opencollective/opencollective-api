import config from 'config';
import { Request, Response } from 'express';

import { canSeeExpenseAttachments } from '../graphql/common/expenses';
import { getSignedGetURL, parseS3Url } from '../lib/awsS3';
import { Collective, Expense, ExpenseAttachedFile, ExpenseItem, UploadedFile } from '../models';
import { SUPPORTED_FILE_TYPES_IMAGES } from '../models/UploadedFile';

async function hasUploadedFilePermission(req: Request, uploadedFile: UploadedFile): Promise<boolean> {
  const actualUrl = uploadedFile.getDataValue('url');
  if (req.remoteUser.id !== uploadedFile.CreatedByUserId) {
    switch (uploadedFile.kind) {
      case 'EXPENSE_ITEM': {
        const expenseItem = await ExpenseItem.findOne({
          where: {
            url: actualUrl,
          },
          include: { model: Expense, include: [{ model: Collective, as: 'fromCollective' }] },
        });

        const expense = expenseItem?.Expense;

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

        if (expense && (await canSeeExpenseAttachments(req, expense))) {
          return true;
        }

        break;
      }
    }
  }

  return false;
}

/**
 * GET /files/:base64UrlEncodedUrl
 *
 * Query Params
 *
 * json - return json response
 * thumbnail - return thumbnail json
 */
export async function getFile(req: Request, res: Response) {
  if (!req.remoteUser) {
    return res.status(401).send({ message: 'Authentication Required' });
  }

  const isJsonAccepted = req.query.json !== undefined;
  const isThumbnail = req.query.thumbnail !== undefined;

  const { base64UrlEncodedUrl } = req.params;

  const uploadedFileUrl = Buffer.from(base64UrlEncodedUrl, 'base64url').toString();
  const uploadedFile = await UploadedFile.findOne({
    where: {
      url: uploadedFileUrl,
    },
  });

  if (!uploadedFile) {
    return res.status(403).send({ message: 'Unauthorized' });
  }

  const actualUrl = uploadedFile.getDataValue('url');

  if (!hasUploadedFilePermission(req, uploadedFile)) {
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
