import config from 'config';

const TRUSTED_IMAGE_PROVIDERS = [
  'gravatar.com',
  'logo.clearbit.com',
  'avatars.githubusercontent.com',
  'pbs.twimg.com',
  'abs.twimg.com',
  'secure.meetupstatic.com',
];

const getHostname = url => {
  return new URL(url).hostname.replace(/^www\./, '');
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
  } else if (new RegExp(`^https://${config.aws.s3.bucket}\\.s3[.-]us-west-1.amazonaws.com/`).test(url)) {
    return true;
  } else if (allowTrustedThirdPartyImages && TRUSTED_IMAGE_PROVIDERS.includes(getHostname(url))) {
    return true;
  }

  return false;
};
