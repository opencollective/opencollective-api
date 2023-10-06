import { expect } from 'chai';

import { getS3URL } from '../../../server/lib/awsS3';

describe('/server/lib/awss3', () => {
  describe('getS3URL', () => {
    it('properly sanitizes the URL', () => {
      expect(getS3URL('my-bucket', 'my/path/hello world.jpg')).to.equal(
        'https://my-bucket.s3.us-west-1.amazonaws.com/my/path/hello%20world.jpg',
      );
    });
  });
});
