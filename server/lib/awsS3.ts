import fs from 'fs';
import path from 'path';

import {
  CopyObjectCommand,
  CopyObjectRequest,
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  DeleteObjectOutput,
  GetObjectCommand,
  GetObjectCommandOutput,
  HeadBucketCommand,
  HeadObjectCommand,
  HeadObjectOutput,
  ListObjectsV2Command,
  ListObjectsV2Output,
  ObjectCannedACL,
  PutBucketPolicyCommand,
  PutObjectCommand,
  PutObjectCommandOutput,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
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

/**
 * Returns a signed GET url to an S3 resource.
 * By default the URL expires in 10 minutes.
 */
export function getSignedGetURL(params: GetObjectCommand['input'], options?: { expiresIn: number }) {
  const command = new GetObjectCommand(params);
  return getSignedUrl(s3, command, { expiresIn: options?.expiresIn || 10 * 60 });
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
    const filePath = path.resolve('/tmp', params.Key);
    if (!filePath.startsWith('/tmp')) {
      throw new Error('Invalid file path');
    }
    logger.warn(`S3 is not set, saving file to ${filePath}. This should only be done in development.`);
    const isBuffer = params.Body instanceof Buffer;
    fs.writeFile(
      filePath,
      isBuffer ? new Uint8Array(params.Body as Buffer) : params.Body.toString('utf8'),
      logger.info,
    );
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

export const objectExists = async (s3Url: string): Promise<boolean> => {
  try {
    await getFileInfoFromS3(s3Url);
    return true;
  } catch (err) {
    if (err.$metadata.httpStatusCode === 404) {
      return false;
    }
    throw err;
  }
};

export const getObjectFromUrl = async (s3Url: string): Promise<GetObjectCommandOutput> => {
  if (!s3) {
    throw new Error('S3 is not set');
  }

  const { bucket, key } = parseS3Url(s3Url);
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  return await s3.send(command);
};

export const getFileFromS3 = async (s3Url: string): Promise<Buffer> => {
  const data = await getObjectFromUrl(s3Url);
  const body = await data.Body?.transformToByteArray();
  if (!body) {
    throw new Error('Failed to get file from S3');
  }

  return Buffer.from(body);
};

/**
 * A wrapper around S3.listObjectsV2 that handles pagination to get more than 1000 files.
 */
export const listFilesInS3 = async (
  bucket: string,
  keyPrefix = undefined,
): Promise<ListObjectsV2Output['Contents']> => {
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

    const command = new ListObjectsV2Command({
      Bucket: bucket,
      ContinuationToken: continuationToken,
      Prefix: keyPrefix,
    });
    const data = (await s3.send(command)) as ListObjectsV2Output;
    allObjects.push(...(data.Contents || []));
    continuationToken = data.NextContinuationToken;
  } while (continuationToken);

  return allObjects;
};

export const copyFileInS3 = async (
  s3Url: string,
  newKey: string,
  params: Omit<CopyObjectRequest, 'Bucket' | 'CopySource' | 'Key'> = {},
) => {
  if (!s3) {
    throw new Error('S3 is not set');
  }

  const { bucket, key } = parseS3Url(s3Url);
  logger.debug(`Copying S3 file ${s3Url} (${key}) to ${newKey}`);

  try {
    return s3.send(
      new CopyObjectCommand({
        MetadataDirective: 'COPY',
        Bucket: bucket,
        CopySource: `${bucket}/${encodeURIComponent(key)}`,
        Key: newKey,
        ...params,
      }),
    );
  } catch (e) {
    logger.error(`Error copying S3 file ${s3Url} (${key}) to ${newKey}:`, e);
    throw e;
  }
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

/**
 * WARNING: This will permanently delete the file from S3. Use `trashFileFromS3` instead if
 * you want to move the file to a trash folder.
 */
export const permanentlyDeleteFileFromS3 = async (bucket: string, key: string): Promise<DeleteObjectOutput> => {
  if (!s3) {
    throw new Error('S3 is not set');
  }

  try {
    return s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  } catch (e) {
    logger.error(`Error deleting S3 file ${key}:`, e);
    throw e;
  }
};

export const checkBucketExists = async (bucket: string): Promise<boolean> => {
  if (!s3) {
    throw new Error('S3 is not set');
  }
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    return true;
  } catch {
    return false;
  }
};

export const createBucket = async (bucket: string): Promise<void> => {
  if (!s3) {
    throw new Error('S3 is not set');
  }
  try {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  } catch (e) {
    logger.error(`Error creating bucket ${bucket}:`, e);
    throw e;
  }
};

/**
 * This function initializes the S3 buckets for non-production environments.
 */
export const dangerouslyInitNonProductionBuckets = async ({
  dropExisting = false,
}: { dropExisting?: boolean } = {}) => {
  const buckets = [
    { name: config.aws.s3.bucket, policy: s3BucketNonProductionPolicy },
    { name: config.taxForms.aws.s3.bucket, policy: s3TaxFormsBucketNonProductionPolicy },
  ];

  for (const bucket of buckets) {
    const bucketExists = await checkBucketExists(bucket.name);
    if (dropExisting && bucketExists) {
      logger.info(`Bucket ${bucket.name} already exists, dropping...`);
      await s3.send(new DeleteBucketCommand({ Bucket: bucket.name }));
    } else if (bucketExists) {
      logger.info(`Bucket ${bucket.name} already exists`);
      continue;
    }

    logger.info(`Creating bucket ${bucket.name}...`);
    await createBucket(bucket.name);

    await s3.send(
      new PutBucketPolicyCommand({
        Bucket: bucket.name,
        Policy: bucket.policy,
      }),
    );
  }
};

export const checkS3Configured = (): boolean => Boolean(s3);

const s3TaxFormsBucketNonProductionPolicy = `
{
    "ID": "Policy1445855025726",
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Deny",
            "Principal": {
                "AWS": [
                    "*"
                ]
            },
            "Action": [
              "s3:GetObject",
              "s3:ListBucket",
              "s3:PutObject"
            ],
            "Resource": [
                "arn:aws:s3:::*"
            ],
            "Condition": {
                "StringNotEquals": {
                    "aws:username": [
                        "user"
                    ]
                }
            }
        }
    ]
}
`;

const s3BucketNonProductionPolicy = `
{
    "ID": "Policy1445855025726",
    "Version": "2012-10-17",
    "Statement": [
        {
            "Effect": "Deny",
            "Principal": {
                "AWS": [
                    "*"
                ]
            },
            "Action": [
                "s3:GetObject"
            ],
            "Resource": [
                "arn:aws:s3:::*/expense-attached-file/*",
                "arn:aws:s3:::*/expense-invoice/*",
                "arn:aws:s3:::*/expense-item/*"
            ],
            "Condition": {
                "StringNotEquals": {
                    "aws:username": [
                        "user"
                    ]
                }
            }
        },
        {
            "Effect": "Allow",
            "Principal": {
                "AWS": [
                    "*"
                ]
            },
            "Action": [
                "s3:GetBucketLocation",
                "s3:ListBucket",
                "s3:ListBucketMultipartUploads"
            ],
            "Resource": [
                "arn:aws:s3:::*"
            ]
        },
        {
            "Effect": "Allow",
            "Principal": {
                "AWS": [
                    "*"
                ]
            },
            "Action": [
                "s3:AbortMultipartUpload",
                "s3:DeleteObject",
                "s3:GetObject",
                "s3:ListMultipartUploadParts",
                "s3:PutObject"
            ],
            "Resource": [
                "arn:aws:s3:::*/*"
            ]
        }
    ]
}
`;

export default s3;
