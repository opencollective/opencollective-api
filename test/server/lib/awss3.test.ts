import { expect } from 'chai';
import config from 'config';

import { getS3URL } from '../../../server/lib/awsS3';

describe('/server/lib/awss3', () => {
  describe('getS3URL', () => {
    it('properly sanitizes the URL', () => {
      expect(getS3URL('my-bucket', 'my/path/hello world.jpg')).to.equal(
        `${config.aws.s3.endpoint}/my-bucket/my/path/hello%20world.jpg`,
      );
    });
  });
});
