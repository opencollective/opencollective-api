import fs from 'fs';

import S3, { ManagedUpload, PutObjectRequest } from 'aws-sdk/clients/s3.js';
import config from 'config';

import logger from '../lib/logger.js';

import { reportErrorToSentry } from './sentry.js';

export const S3_TRASH_PREFIX = 'trash/';

// Create S3 service object & set credentials and region
let s3: S3;
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
      s3.upload(params, (err, data) => {
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

/**
 * A wrapper around S3.listObjectsV2 that handles pagination to get more than 1000 files.
 */
export const listFilesInS3 = async (bucket: string): Promise<S3.Object[]> => {
  if (!s3) {
    throw new Error('S3 is not set');
  }

  const listObjects = async (params: S3.ListObjectsV2Request): Promise<S3.ListObjectsV2Output> => {
    return new Promise((resolve, reject) => {
      s3.listObjectsV2(params, (err, data) => {
        if (err) {
          reject(err);
        } else {
          resolve(data);
        }
      });
    });
  };

  const allObjects: S3.Object[] = [];
  let continuationToken: string | undefined;
  do {
    logger.debug(
      `Fetching S3 objects for bucket ${bucket} ${
        continuationToken ? `with continuation token ${continuationToken}` : ''
      }`,
    );
    const data = await listObjects({ Bucket: bucket, ContinuationToken: continuationToken });
    allObjects.push(...(data.Contents || []));
    continuationToken = data.NextContinuationToken;
  } while (continuationToken);

  return allObjects;
};

/**
 * Move S3 file to a new key, within the same bucket.
 */
export const moveFileInS3 = (
  s3Url: string,
  newKey: string,
  params: Omit<S3.Types.CopyObjectRequest, 'Bucket' | 'CopySource' | 'Key'> = {},
): Promise<void> => {
  // Unfortunately, s3 has no `moveObject` method, so we have to copy and delete. See https://docs.aws.amazon.com/sdk-for-java/v1/developer-guide/examples-s3-objects.html#copy-object
  return new Promise((resolve, reject) => {
    if (s3) {
      const { bucket, key } = parseS3Url(s3Url);
      logger.debug(`Moving S3 file ${s3Url} (${key}) to ${newKey}`);
      // const storageType = 'GLACIER_IR' : 'STANDARD';
      s3.copyObject(
        {
          MetadataDirective: 'COPY',
          ...params,
          Bucket: bucket,
          CopySource: `${bucket}/${encodeURIComponent(key)}`,
          Key: newKey,
        },
        err => {
          if (err) {
            reject(err);
          } else {
            s3.deleteObject({ Bucket: bucket, Key: key }, err => {
              if (err) {
                reject(err);
              } else {
                resolve();
              }
            });
          }
        },
      );
    } else {
      reject(new Error('S3 is not set'));
    }
  });
};

// To differentiate between files that were deleted and files that were never recorded in the DB
type TrashType = 'deleted' | 'neverRecorded';

/**
 * Until we're confident permanently deleting files from S3, we'll just move them to a trash folder.
 */
export const trashFileFromS3 = async (s3Url: string, trashType: TrashType): Promise<void> => {
  const { key } = parseS3Url(s3Url);
  const trashKey = `${S3_TRASH_PREFIX}${trashType}/${key}`;
  return moveFileInS3(s3Url, trashKey, { StorageClass: 'GLACIER' });
};

/**
 * Restore the file from the trash folder to its original location.
 */
export const restoreFileFromS3Trash = (s3Url: string, trashType: TrashType): Promise<void> => {
  const { key } = parseS3Url(s3Url);
  const originalKey = key.replace(new RegExp(`^${S3_TRASH_PREFIX}${trashType}/`), '');
  return moveFileInS3(s3Url, originalKey, { StorageClass: 'STANDARD' });
};

export default s3;
