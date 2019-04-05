import config from 'config';
import aws from 'aws-sdk';

// S3 bucket
let awsClient;

if (config.aws.s3.key) {
  awsClient = aws.config.update({
    accessKeyId: config.aws.s3.key,
    secretAcessKey: config.aws.s3.secret,
    region: 'us-west-1',
  });
}

const S3 = new awsClient.S3();

export default S3;
