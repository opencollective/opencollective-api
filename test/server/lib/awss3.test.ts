import { GetBucketCorsCommand, PutBucketCorsCommand } from '@aws-sdk/client-s3';
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

    const websiteRule = {
      AllowedOrigins: [config.host.website],
      AllowedMethods: ['GET', 'HEAD'],
      AllowedHeaders: ['*'],
      MaxAgeSeconds: 3600,
    };
    const corsRules = async () => (await s3.send(new GetBucketCorsCommand({ Bucket: config.aws.s3.bucket }))).CORSRules;

    it('lets the website read files from the uploads bucket, as the production bucket does', async () => {
      // Runs again on existing buckets: the rule must reach buckets created before it existed.
      await dangerouslyInitNonProductionBuckets();
      expect(await corsRules()).to.deep.include(websiteRule);
    });

    it('keeps the CORS rules a developer added to an existing bucket, and adds the website rule once', async () => {
      await dangerouslyInitNonProductionBuckets();
      const ownRule = { AllowedOrigins: ['http://localhost:4000'], AllowedMethods: ['PUT'], AllowedHeaders: ['*'] };
      await s3.send(
        new PutBucketCorsCommand({ Bucket: config.aws.s3.bucket, CORSConfiguration: { CORSRules: [ownRule] } }),
      );

      await dangerouslyInitNonProductionBuckets();
      await dangerouslyInitNonProductionBuckets();

      const rules = await corsRules();
      expect(rules).to.have.length(2);
      expect(rules).to.deep.include(ownRule);
      expect(rules).to.deep.include(websiteRule);
    });

    it('leaves an existing rule that already lets the website read files untouched', async () => {
      await dangerouslyInitNonProductionBuckets();
      const anyOriginRule = { AllowedOrigins: ['*'], AllowedMethods: ['GET', 'HEAD', 'PUT'], AllowedHeaders: ['*'] };
      await s3.send(
        new PutBucketCorsCommand({ Bucket: config.aws.s3.bucket, CORSConfiguration: { CORSRules: [anyOriginRule] } }),
      );

      await dangerouslyInitNonProductionBuckets();

      expect(await corsRules()).to.deep.equal([anyOriginRule]);
    });
  });
});
