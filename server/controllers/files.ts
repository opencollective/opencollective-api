import config from 'config';
import { Request, Response } from 'express';

import { hasUploadedFilePermission } from '../graphql/common/uploaded-file';
import { idDecode, IDENTIFIER_TYPES } from '../graphql/v2/identifiers';
import { getSignedGetURL, parseS3Url } from '../lib/awsS3';
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
