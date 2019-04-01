import path from 'path';
import uuidv1 from 'uuid/v1';

import errors from '../lib/errors';
import awsClient from '../lib/aws';

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
    return next(
      new errors.ValidationFailed('invalid mimetype', {
        file: 'Mimetype of the file should be image/png, image/jpeg or application/pdf',
      }),
    );
  }

  if (file.size > 1024 * 1024 * 10) {
    return next(
      new errors.ValidationFailed('invalid filesize', {
        file: 'Filesize cannot exceed 10MB',
      }),
    );
  }

  if (!knox) {
    return next(new errors.ServerError('AWS Knox client not initialized'));
  }

  /**
   * We will replace the name to avoid collisions
   */

  const ext = path.extname(file.originalname);
  const filename = ['/', uuidv1(), ext].join('');

  const s3 = new AWS.S3({
    params: {Bucket: awsClient.bucket},
    ContentType: file.mimetype,
    ACL: 'public-read'
  });

  const config = {
    Key: filename,
    Body: filename,
    ACL: 'public-read'
  }

s3.upload(config)
 
  req.setTimeout(IMAGE_UPLOAD_TIMEOUT);

}
