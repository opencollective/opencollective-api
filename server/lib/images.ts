import config from 'config';

import UploadedFile, { SUPPORTED_FILE_TYPES_IMAGES } from '../models/UploadedFile';

import { getHostname } from './url-utils';

const TRUSTED_IMAGE_PROVIDERS = [
  'gravatar.com',
  'logo.clearbit.com',
  'avatars.githubusercontent.com',
  'pbs.twimg.com',
  'abs.twimg.com',
  'secure.meetupstatic.com',
];

export const isSupportedImageMimeType = (mimeType: string): boolean => {
  return (SUPPORTED_FILE_TYPES_IMAGES as readonly string[]).includes(mimeType);
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
  } else if (UploadedFile.isOpenCollectiveS3BucketURL(url)) {
    return true;
  } else if (allowTrustedThirdPartyImages && TRUSTED_IMAGE_PROVIDERS.includes(getHostname(url))) {
    return true;
  }

  return false;
};
