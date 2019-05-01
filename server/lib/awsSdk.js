import aws from 'aws-sdk';
import config from 'config';

// s3 bucket
if (config.aws.s3.key) {
  aws.config.update({
    accessKeyId: config.aws.s3.key,
    secretAccessKey: config.aws.s3.secret,
    region: 'us-west-1',
  });
}

const s3 = new aws.S3();

export default s3;
