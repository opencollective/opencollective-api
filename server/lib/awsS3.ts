import fs from 'fs';

import S3, { ManagedUpload, PutObjectRequest } from 'aws-sdk/clients/s3';
import config from 'config';

import logger from '../lib/logger';

// Create S3 service object & set credentials and region
let s3;
if (config.aws.s3.key) {
  s3 = new S3({
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
          reject(err);
        } else {
          resolve(data);
        }
      });
    } else {
      const Location = `/tmp/${params.Key}`;
      logger.warn(`S3 is not set, saving file to ${Location}. This should only be done in development.`);
      fs.writeFile(Location, params.Body.toString('utf8'), logger.info);
      resolve({ Location: `file://${Location}`, Bucket: 'local-tmp', Key: params.Key });
    }
  });

export default s3;
