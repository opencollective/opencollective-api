import fs from 'fs';

import S3, { ManagedUpload, PutObjectRequest } from 'aws-sdk/clients/s3';
import config from 'config';

import logger from '../lib/logger';

import { reportErrorToSentry } from './sentry';

// Create S3 service object & set credentials and region
let s3;
if (config.aws.s3.key) {
  s3 = new S3({
    s3ForcePathStyle: config.aws.s3.forcePathStyle,
    endpoint: config.aws.s3.endpoint,
    sslEnabled: config.aws.s3.sslEnabled,
    accessKeyId: config.aws.s3.key,
    secretAccessKey: config.aws.s3.secret,
    apiVersion: config.aws.s3.apiVersion,
    region: config.aws.s3.region,
  });
}

export const uploadToS3 = (
  params: PutObjectRequest,
): Promise<ManagedUpload.SendData | { Location: string; Bucket: string; Key: string }> =>
  new Promise((resolve, reject) => {
    if (s3) {
      (s3 as S3).upload(params, (err, data) => {
        if (err) {
          logger.error('Error uploading file to S3: ', err);
          reportErrorToSentry(err);
          reject(err);
        } else {
          resolve(data);
        }
      });
    } else {
      const Location = `/tmp/${params.Key}`;
      logger.warn(`S3 is not set, saving file to ${Location}. This should only be done in development.`);
      const isBuffer = params.Body instanceof Buffer;
      fs.writeFile(Location, isBuffer ? <Buffer>params.Body : params.Body.toString('utf8'), logger.info);
      resolve({ Location: `file://${Location}`, Bucket: 'local-tmp', Key: params.Key });
    }
  });

/**
 * Parse S3 URL to get bucket and key. Throws if the URL is not a valid S3 URL.
 */
export const parseS3Url = (s3Url: string): { bucket: string; key: string } => {
  const parsedUrl = new URL(s3Url);
  if (!parsedUrl.hostname.endsWith('.amazonaws.com')) {
    throw new Error(`Invalid S3 URL: ${s3Url}`);
  }

  return {
    bucket: parsedUrl.hostname.replace(/\.s3[.-][^.]+\.amazonaws\.com$/, ''), // Bucket name is the hostname minus the region, the s3 prefix and aws domain
    key: decodeURIComponent(parsedUrl.pathname.slice(1)), // Remove leading slash
  };
};

export const getFileInfoFromS3 = (s3Url: string): Promise<S3.HeadObjectOutput> => {
  return new Promise((resolve, reject) => {
    if (s3) {
      const { bucket, key } = parseS3Url(s3Url);
      s3.headObject({ Bucket: bucket, Key: key }, (err, data) => {
        if (err) {
          reject(err);
        } else {
          resolve(data);
        }
      });
    } else {
      reject(new Error('S3 is not set'));
    }
  });
};

export default s3;
