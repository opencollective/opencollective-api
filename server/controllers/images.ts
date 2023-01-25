import path from 'path';

import { ManagedUpload } from 'aws-sdk/clients/s3';
import { encode } from 'blurhash';
import config from 'config';
import { kebabCase } from 'lodash';
import sharp from 'sharp';
import { v1 as uuid } from 'uuid';

import s3, { uploadToS3 } from '../lib/awsS3';
import errors from '../lib/errors';
import { isSupportedImageMimeType } from '../lib/images';
import { reportErrorToSentry } from '../lib/sentry';
import models from '../models';
import { SUPPORTED_FILE_EXTENSIONS, SUPPORTED_FILE_KINDS, SUPPORTED_FILE_TYPES } from '../models/UploadedFile';

// Use a 2 minutes timeout for image upload requests as the default 25 seconds
// often leads to failing requests.
const IMAGE_UPLOAD_TIMEOUT = 2 * 60 * 1000;

const getUploadedFileData = async file => {
  if (isSupportedImageMimeType(file.mimetype)) {
    const image = sharp(file.buffer);
    const { width, height } = await image.metadata();
    const pixels = await image.raw().ensureAlpha().toBuffer({ resolveWithObject: true });
    const blurHash = encode(pixels.data, width, height, 4, 4); // TODO find optimal values
    return { width, height, blurHash };
  } else {
    return null;
  }
};

const recordUploadedFile = async (
  req,
  kind,
  file,
  fileName,
  s3Data: ManagedUpload.SendData | { Location: string; Bucket: string; Key: string },
): Promise<void> => {
  try {
    await models.UploadedFile.create({
      kind: kind,
      fileName,
      fileSize: file.size,
      fileType: file.mimetype,
      url: s3Data.Location,
      data: await getUploadedFileData(file),
      CreatedByUserId: req.remoteUser.id,
    });
  } catch (e) {
    // Since this runs async, we need to report the error to Sentry in case it fails
    console.error(e);
    reportErrorToSentry(e, {
      severity: 'error',
      user: req.remoteUser,
      transactionName: 'recordUploadedFile',
      extra: { kind, fileName, fileType: file.mimetype },
    });
  }
};

const getFilename = (file, fileNameFromArgs) => {
  const expectedExtension = SUPPORTED_FILE_EXTENSIONS[file.mimetype];
  const rawFileName = fileNameFromArgs || file.originalname || uuid();
  const parsedFileName = path.parse(rawFileName);
  return `${parsedFileName.name}${expectedExtension}`;
};

export default async function uploadImage(req, res, next) {
  const { kind } = req.body;

  if (!req.remoteUser) {
    return next(new errors.Unauthorized('You need to be logged in to upload a file'));
  }

  if (!kind) {
    return next(
      new errors.ValidationFailed('missing_required', {
        kind: 'Kind field is required and missing',
      }),
    );
  }

  if (!SUPPORTED_FILE_KINDS.includes(kind)) {
    const message = `Kind should be one of: ${SUPPORTED_FILE_KINDS.join(', ')}`;
    return next(new errors.ValidationFailed('INVALID_FILE_KIND', { kind: message }, message));
  }

  // Required fields
  const file = req.file;
  if (!file) {
    return next(
      new errors.ValidationFailed('missing_required', {
        file: 'File field is required and missing',
      }),
    );
  }

  // Validate file
  if (!SUPPORTED_FILE_TYPES.includes(file.mimetype)) {
    const message = `Mimetype of the file should be one of: ${SUPPORTED_FILE_TYPES.join(', ')}`;
    return next(new errors.ValidationFailed('INVALID_FILE_MIME_TYPE', { file: message }, message));
  }

  if (file.size > 1024 * 1024 * 10) {
    const message = 'Filesize cannot exceed 10MB';
    return next(
      new errors.ValidationFailed('INVALID_FILE_SIZE_TOO_BIG', { file: message }, message, {
        fileSize: file.size,
        max: '10MB',
      }),
    );
  }

  if (!s3) {
    return next(new errors.ServerError('S3 service object not initialized'));
  }

  /**
   * We will replace the name to avoid collisions
   */
  const fileName = getFilename(file, req.body.fileName);
  const uploadParams = {
    Bucket: config.aws.s3.bucket,
    Key: `${kebabCase(kind)}/${uuid()}/${fileName || uuid()}`,
    Body: file.buffer,
    ACL: 'public-read', // We're aware of the security implications of this and will be looking for a better solution in https://github.com/opencollective/opencollective/issues/6351
    ContentLength: file.size,
    ContentType: file.mimetype,
    Metadata: {
      CreatedByUserId: `${req.remoteUser.id}`,
      FileKind: kind,
    },
  };

  req.setTimeout(IMAGE_UPLOAD_TIMEOUT);

  try {
    const data = await uploadToS3(uploadParams);
    recordUploadedFile(req, kind, file, fileName, data); // Record the uploaded file asynchronously
    res.send({ status: 200, url: data.Location });
  } catch (err) {
    next(new errors.ServerError(`Error: ${err}`));
  }
}
