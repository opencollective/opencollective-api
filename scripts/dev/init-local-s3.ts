/**
 * A script that connects to the local S3 server and creates the necessary buckets.
 */

import '../../server/env';

import config from 'config';

import s3, { dangerouslyInitNonProductionBuckets } from '../../server/lib/awsS3';

if (!s3) {
  throw new Error('S3 service object not initialized');
}

const main = async () => {
  if (config.env === 'production') {
    throw new Error('This script is not available in the production environment');
  }

  await dangerouslyInitNonProductionBuckets();
};

main().catch(err => {
  console.error(err);
  process.exit(1);
});
