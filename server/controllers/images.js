import path from 'path';

import config from 'config';
import { v1 as uuid } from 'uuid';

import s3, { uploadToS3 } from '../lib/awsS3';
import errors from '../lib/errors';

// Use a 2 minutes timeout for image upload requests as the default 25 seconds
// often leads to failing requests.
const IMAGE_UPLOAD_TIMEOUT = 2 * 60 * 1000;

export default function uploadImage(req, res, next) {
  const file = req.file;

  if (!file) {
    return next(
      new errors.ValidationFailed('missing_required', {
        file: 'File field is required and missing',
      }),
    );
  }

  if (!file.mimetype || !(file.mimetype.match(/image\/.*/i) || file.mimetype.match(/application\/pdf/i))) {
    const message = 'Mimetype of the file should be image/png, image/jpeg or application/pdf';
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
  const ext = path.extname(file.originalname);
  const filename = [uuid(), ext].join('');

  const uploadParams = {
    Bucket: config.aws.s3.bucket,
    Key: filename,
    Body: file.buffer,
    ACL: 'public-read',
    ContentLength: file.size,
    ContentType: file.mimetype,
  };

  req.setTimeout(IMAGE_UPLOAD_TIMEOUT);

  uploadToS3(uploadParams)
    .then(data => {
      res.send({
        status: 200,
        url: data.Location,
      });
    })
    .catch(err => {
      next(new errors.ServerError(`Error: ${err}`));
    });
}
