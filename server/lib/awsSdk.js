import aws from 'aws-sdk';
import config from 'config';

// s3 bucket
let s3;
if (config.aws.s3.key) {
  s3 = new aws.Config({
    accessKeyId: config.aws.s3.key,
    secretAccessKey: config.aws.s3.secret,
    region: 'us-west-1',
    s3BucketEndpoint: config.aws.s3.bucket,
  });
}

export default s3;
