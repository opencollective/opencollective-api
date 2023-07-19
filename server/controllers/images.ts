import s3 from '../lib/awsS3.js';
import errors from '../lib/errors.js';
import UploadedFile, { SUPPORTED_FILE_KINDS, SUPPORTED_FILE_TYPES } from '../models/UploadedFile.js';
import { MulterFile } from '../types/Multer.js';

// Use a 2 minutes timeout for image upload requests as the default 25 seconds
// often leads to failing requests.
const IMAGE_UPLOAD_TIMEOUT = 2 * 60 * 1000;

export default async function uploadImage(req, res, next) {
  if (!req.remoteUser) {
    return next(new errors.Unauthorized('You need to be logged in to upload a file'));
  }

  // We keep all the validations below even though `uploadFileToS3` already does some of them
  // because multiple tests (both E2E and unit tests) rely on it.
  const { kind, fileName } = req.body;
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
  const file: MulterFile = req.file;
  if (!file) {
    return next(
      new errors.ValidationFailed('missing_required', {
        file: 'File field is required and missing',
      }),
    );
  }

  // Validate file
  if (!UploadedFile.isSupportedMimeType(file.mimetype)) {
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

  // Trigger the upload
  req.setTimeout(IMAGE_UPLOAD_TIMEOUT);
  try {
    const uploadedFile = await UploadedFile.upload(file, kind, req.remoteUser, { fileName });
    res.send({ status: 200, url: uploadedFile.url });
  } catch (err) {
    next(new errors.ServerError(`Error: ${err}`));
  }
}
