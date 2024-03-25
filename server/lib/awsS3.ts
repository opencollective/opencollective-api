import fs from 'fs';

import {
  CopyObjectCommand,
  CopyObjectRequest,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  HeadObjectOutput,
  ListObjectsV2Command,
  ListObjectsV2Output,
  ObjectCannedACL,
  PutObjectCommand,
  PutObjectCommandOutput,
  S3Client,
} from '@aws-sdk/client-s3';
import config from 'config';

import logger from '../lib/logger';

import { reportErrorToSentry } from './sentry';

export const S3_TRASH_PREFIX = 'trash/';

// Create S3 service object & set credentials and region
let s3: S3Client;
if (config.aws.s3.key) {
  s3 = new S3Client({
    forcePathStyle: config.aws.s3.forcePathStyle,
    endpoint: config.aws.s3.endpoint,
    tls: config.aws.s3.sslEnabled,
    apiVersion: config.aws.s3.apiVersion,
    region: config.aws.s3.region,
    credentials: {
      accessKeyId: config.aws.s3.key,
      secretAccessKey: config.aws.s3.secret,
    },
  });
}

export const uploadToS3 = async (
  params: PutObjectCommand['input'],
): Promise<{
  s3Data?: PutObjectCommandOutput;
  url: string;
}> => {
  if (s3) {
    try {
      const command = new PutObjectCommand(params);
      const result = (await s3.send(command)) as PutObjectCommandOutput;
      return { s3Data: result, url: getS3URL(params.Bucket, params.Key) };
    } catch (err) {
      if (err) {
        logger.error('Error uploading file to S3: ', err);
        reportErrorToSentry(err);
        throw err;
      }
    }
  } else if (config.env === 'development') {
    const filePath = `/tmp/${params.Key}`;
    logger.warn(`S3 is not set, saving file to ${filePath}. This should only be done in development.`);
    const isBuffer = params.Body instanceof Buffer;
    fs.writeFile(filePath, isBuffer ? <Buffer>params.Body : params.Body.toString('utf8'), logger.info);
    return { url: `file://${filePath}` };
  }
};

/**
 * Parse S3 URL to get bucket and key. Throws if the URL is not a valid S3 URL.
 */
export const parseS3Url = (s3Url: string): { bucket: string; key: string } => {
  const parsedUrl = new URL(s3Url);

  if (config.aws.s3.endpoint && config.aws.s3.forcePathStyle) {
    const pathParts = parsedUrl.pathname.split('/');
    if (pathParts.length < 2) {
      throw new Error(`Invalid S3 URL: ${s3Url}`);
    }

    return {
      bucket: pathParts[1],
      key: decodeURIComponent(pathParts.slice(2).join('/')), // Remove leading slash
    };
  }

  if (!parsedUrl.hostname.endsWith('.amazonaws.com')) {
    throw new Error(`Invalid S3 URL: ${s3Url}`);
  }

  return {
    bucket: parsedUrl.hostname.replace(/\.s3\.[^.]+\.amazonaws\.com$/, ''), // Bucket name is the hostname minus the region, the s3 prefix and aws domain
    key: decodeURIComponent(parsedUrl.pathname.slice(1)), // Remove leading slash
  };
};

/**
 * Generate an S3 URL from a bucket and key.
 */
export const getS3URL = (bucket: string, key: string): string => {
  // Only the last part of the key should be encoded
  const keyParts = key.split('/');
  const encodedKeyLastPart = encodeURIComponent(keyParts.pop() || '');
  const fullKey = [...keyParts, encodedKeyLastPart].join('/');

  if (config.aws.s3.endpoint && config.aws.s3.forcePathStyle) {
    return `${config.aws.s3.endpoint}/${bucket}/${fullKey}`;
  }

  return `https://${bucket}.s3.${config.aws.s3.region}.amazonaws.com/${fullKey}`;
};

export const getFileInfoFromS3 = async (s3Url: string): Promise<HeadObjectOutput> => {
  if (!s3) {
    throw new Error('S3 is not set');
  }

  const { bucket, key } = parseS3Url(s3Url);
  const command = new HeadObjectCommand({ Bucket: bucket, Key: key });
  return s3.send(command) as Promise<HeadObjectOutput>;
};

export const getFileFromS3 = async (s3Url: string): Promise<Buffer> => {
  if (!s3) {
    throw new Error('S3 is not set');
  }

  const { bucket, key } = parseS3Url(s3Url);
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  const data = await s3.send(command);
  const body = await data.Body?.transformToByteArray();
  if (!body) {
    throw new Error('Failed to get file from S3');
  }

  return Buffer.from(body);
};

/**
 * A wrapper around S3.listObjectsV2 that handles pagination to get more than 1000 files.
 */
export const listFilesInS3 = async (bucket: string): Promise<ListObjectsV2Output['Contents']> => {
  if (!s3) {
    throw new Error('S3 is not set');
  }

  const allObjects: ListObjectsV2Output['Contents'] = [];
  let continuationToken: string | undefined;
  do {
    logger.debug(
      `Fetching S3 objects for bucket ${bucket} ${
        continuationToken ? `with continuation token ${continuationToken}` : ''
      }`,
    );

    const command = new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: continuationToken });
    const data = (await s3.send(command)) as ListObjectsV2Output;
    allObjects.push(...(data.Contents || []));
    continuationToken = data.NextContinuationToken;
  } while (continuationToken);

  return allObjects;
};

/**
 * Move S3 file to a new key, within the same bucket.
 */
export const moveFileInS3 = async (
  s3Url: string,
  newKey: string,
  params: Omit<CopyObjectRequest, 'Bucket' | 'CopySource' | 'Key'> = {},
): Promise<void> => {
  if (!s3) {
    throw new Error('S3 is not set');
  }

  const { bucket, key } = parseS3Url(s3Url);
  logger.debug(`Moving S3 file ${s3Url} (${key}) to ${newKey}`);

  // Unfortunately, s3 has no `moveObject` method, so we have to copy and delete. See https://docs.aws.amazon.com/sdk-for-java/v1/developer-guide/examples-s3-objects.html#copy-object
  try {
    // Copy
    await s3.send(
      new CopyObjectCommand({
        MetadataDirective: 'COPY',
        Bucket: bucket,
        CopySource: `${bucket}/${encodeURIComponent(key)}`,
        Key: newKey,
        ...params,
      }),
    );

    // Delete old file
    await s3.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
    );
  } catch (e) {
    logger.error(`Error moving S3 file ${s3Url} (${key}) to ${newKey}:`, e);
    throw e;
  }
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
 * Remember to specify the `ACL` to `public-read` if you want the file to be public.
 */
export const restoreFileFromS3Trash = (s3Url: string, trashType: TrashType, acl?: ObjectCannedACL): Promise<void> => {
  const { key } = parseS3Url(s3Url);
  const originalKey = key.replace(new RegExp(`^${S3_TRASH_PREFIX}${trashType}/`), '');
  return moveFileInS3(s3Url, originalKey, { StorageClass: 'STANDARD', ACL: acl });
};

export const checkS3Configured = (): boolean => Boolean(s3);

export default s3;
