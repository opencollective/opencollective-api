import config from 'config';
import aws from 'aws-sdk';

// S3 bucket
let awsClient;
if (config.aws.s3.key) {
  awsClient = aws.config.update({
    key: config.aws.s3.key,
    secret: config.aws.s3.secret,
    bucket: config.aws.s3.bucket,
    region: 'us-west-1',
  });
}

export default awsClient;
