import config from 'config';
import { isEmpty } from 'lodash';

import { getHostname } from './url-utils';

const TRUSTED_IMAGE_PROVIDERS = [
  'gravatar.com',
  'logo.clearbit.com',
  'avatars.githubusercontent.com',
  'pbs.twimg.com',
  'abs.twimg.com',
  'secure.meetupstatic.com',
];

export const isOpenCollectiveS3BucketURL = (url: string): boolean => {
  if (isOpenCollectiveProtectedS3BucketURL(url)) {
    return true;
  }

  if (!url) {
    return false;
  }

  let parsedURL: URL;
  try {
    parsedURL = new URL(url);
  } catch {
    return false;
  }

  const endpoint = config.aws.s3.endpoint || `https://${config.aws.s3.bucket}.s3.us-west-1.amazonaws.com`;
  const searchParams = parsedURL.searchParams;
  searchParams.delete('draftKey');
  searchParams.delete('expenseId');
  return (
    parsedURL.origin === endpoint &&
    /\/\w+/.test(parsedURL.pathname) &&
    searchParams.size === 0 &&
    isEmpty(parsedURL.hash) &&
    isEmpty(parsedURL.username) &&
    isEmpty(parsedURL.password)
  );
};

export const isOpenCollectiveProtectedS3BucketURL = (url: string): boolean => {
  if (!url) {
    return false;
  }

  let parsedURL: URL;
  try {
    parsedURL = new URL(url);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
  } catch (e) {
    return false;
  }

  return parsedURL.origin === config.host.website && /^\/api\/files\/[^\/]+\/?$/.test(parsedURL.pathname);
};

/**
 * Returns true if image is a valid image uploaded in our S3 bucket.
 * Allow any image on non-production environments
 */
export const isValidUploadedImage = (
  url: string,
  { ignoreInNonProductionEnv = true, allowTrustedThirdPartyImages = false } = {},
): boolean => {
  if (config.env !== 'production' && ignoreInNonProductionEnv) {
    return true;
  } else if (isOpenCollectiveS3BucketURL(url)) {
    return true;
  } else if (allowTrustedThirdPartyImages && TRUSTED_IMAGE_PROVIDERS.includes(getHostname(url))) {
    return true;
  }

  return false;
};
