/**
 * Returns true if image is a valid OC image uploaded in our S3 bucket.
 * Allow any image on non-production environments
 */
export const isValidOCImage = (url: string): boolean => {
  if (process.env.NODE_ENV !== 'production') {
    return true;
  } else {
    return url.startsWith(`${process.env.AWS_S3_BUCKET}.s3-us-west-1.amazonaws.com`);
  }
};
