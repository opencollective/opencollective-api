import { GetBucketCorsCommand } from '@aws-sdk/client-s3';
import { expect } from 'chai';
import config from 'config';

import s3, { checkS3Configured, dangerouslyInitNonProductionBuckets, getS3URL } from '../../../server/lib/awsS3';

describe('/server/lib/awss3', () => {
  describe('getS3URL', () => {
    it('properly sanitizes the URL', () => {
      expect(getS3URL('my-bucket', 'my/path/hello world.jpg')).to.equal(
        `${config.aws.s3.endpoint}/my-bucket/my/path/hello%20world.jpg`,
      );
    });
  });

  describe('dangerouslyInitNonProductionBuckets', () => {
    before(function () {
      if (!checkS3Configured()) {
        this.skip();
      }
    });

    it('lets the website read files from the uploads bucket, as the production bucket does', async () => {
      // Runs again on existing buckets: the rule must reach buckets created before it existed.
      await dangerouslyInitNonProductionBuckets();
      const { CORSRules } = await s3.send(new GetBucketCorsCommand({ Bucket: config.aws.s3.bucket }));
      expect(CORSRules).to.deep.include({
        AllowedOrigins: [config.host.website],
        AllowedMethods: ['GET', 'HEAD'],
        AllowedHeaders: ['*'],
        MaxAgeSeconds: 3600,
      });
    });
  });
});
