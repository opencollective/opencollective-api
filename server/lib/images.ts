import config from 'config';

/**
 * Returns true if image is a valid image uploaded in our S3 bucket.
 * Allow any image on non-production environments
 */
export const isValidUploadedImage = (url: string): boolean => {
  if (config.env !== 'production') {
    return true;
  } else {
    const regex = new RegExp(`^https://${config.aws.s3.bucket}\\.s3[.-]us-west-1.amazonaws.com/`);
    return regex.test(url);
  }
};
