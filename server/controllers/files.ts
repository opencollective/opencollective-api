import config from 'config';
import { Request, Response } from 'express';

import { hasUploadedFilePermission } from '../graphql/common/uploaded-file';
import { idDecode, IDENTIFIER_TYPES } from '../graphql/v2/identifiers';
import { getSignedGetURL, parseS3Url } from '../lib/awsS3';
import { generateThumbnailFromBucketUrl } from '../lib/thumbnails';
import { UploadedFile } from '../models';
import { SUPPORTED_FILE_TYPES_IMAGES } from '../models/UploadedFile';

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

  const isJsonAccepted = req.query.json !== undefined;
  const isThumbnail = req.query.thumbnail !== undefined;
  const isDownload = req.query.download !== undefined;

  const { uploadedFileId } = req.params;
  const { expenseId, draftKey } = req.query;

  if (expenseId && typeof expenseId !== 'string') {
    return res.status(400).send({ message: 'Invalid id' });
  }

  if (draftKey && typeof draftKey !== 'string') {
    return res.status(400).send({ message: 'Invalid id' });
  }

  let decodedId: number;
  try {
    decodedId = idDecode(uploadedFileId, IDENTIFIER_TYPES.UPLOADED_FILE);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch (err) {
    return res.status(400).send({ message: 'Invalid id' });
  }

  const uploadedFile = await UploadedFile.findByPk(decodedId);

  if (!uploadedFile) {
    return res.status(403).send({ message: 'Unauthorized' });
  }

  const actualUrl = uploadedFile.getDataValue('url');

  if (uploadedFile.isPublicFile()) {
    if (isJsonAccepted) {
      return res.send({ url: actualUrl });
    } else {
      return res.redirect(307, actualUrl);
    }
  }

  if (
    !(await hasUploadedFilePermission(req, uploadedFile, {
      expenseId: expenseId ? idDecode(expenseId as string, IDENTIFIER_TYPES.EXPENSE) : null,
      draftKey: draftKey as string,
    }))
  ) {
    return res.status(403).send({ message: 'Unauthorized' });
  }

  let redirectUrl: string;

  if (isThumbnail) {
    const thumbail = await generateThumbnailFromBucketUrl(actualUrl);
    if (thumbail) {
      res.setHeader('Content-Type', 'image/png');
      return res.send(thumbail);
    }

    if (SUPPORTED_FILE_TYPES_IMAGES.includes(uploadedFile.fileType as (typeof SUPPORTED_FILE_TYPES_IMAGES)[number])) {
      redirectUrl = `${config.host.website}/static/images/file-text.svg`;
    } else {
      redirectUrl = `${config.host.website}/static/images/mime-pdf.png`;
    }
  } else {
    if (!UploadedFile.isOpenCollectiveS3BucketURL(actualUrl)) {
      redirectUrl = actualUrl;
    } else {
      const { bucket, key } = parseS3Url(actualUrl);
      const responseContentDisposition = isDownload
        ? `attachment; filename="${encodeURIComponent(uploadedFile.fileName || 'file')}"`
        : null;
      redirectUrl = await getSignedGetURL(
        { Bucket: bucket, Key: key, ResponseContentDisposition: responseContentDisposition },
        { expiresIn: 3600 },
      );
    }
  }

  if (isJsonAccepted) {
    return res.send({ url: redirectUrl });
  } else {
    return res.redirect(307, redirectUrl);
  }
}
