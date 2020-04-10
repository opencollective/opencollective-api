import config from 'config';
import { expect } from 'chai';
import sinon from 'sinon';
import { isValidUploadedImage } from '../../../server/lib/images';

const sandbox = sinon.createSandbox();

describe('server/lib/images', () => {
  describe('isValidUploadedImage', () => {
    describe('In non-prod environment', () => {
      it('always returns  true', () => {
        expect(isValidUploadedImage('test')).to.be.true;
      });
    });

    describe('In prod environment', () => {
      beforeEach(() => {
        // Simulate a production environment during the test
        sandbox.stub(config, 'env').value('production');
        sandbox.stub(config, 'aws').value({ s3: { bucket: 'valid-bucket' } });
      });

      afterEach(() => {
        sandbox.restore();
      });

      it('returns true for valid images based on S3 bucket', () => {
        expect(isValidUploadedImage('https://valid-bucket.s3-us-west-1.amazonaws.com/image.jpg')).to.be.true;
        expect(isValidUploadedImage('https://valid-bucket.s3.us-west-1.amazonaws.com/image.jpg')).to.be.true;
      });

      it('returns false for invalid images', () => {
        expect(isValidUploadedImage('test')).to.be.false;
        expect(isValidUploadedImage('https://malicious-bucket.s3-us-west-1.amazonaws.com/image.jpg')).to.be.false;
        expect(isValidUploadedImage('https://valid-bucket.not-realy.s3.us-west-1.amazonaws.com/image.jpg')).to.be.false;
        expect(isValidUploadedImage('https://valid-bucket.s3.us-west-1.amazonaws.com.fake.com/img.jpg')).to.be.false;
        expect(isValidUploadedImage('https://valid-bucket.s3xus-west-1.amazonaws.com/image.jpg')).to.be.false;
        expect(isValidUploadedImage('https://valid-bucketxs3.us-west-1.amazonaws.com/image.jpg')).to.be.false;
      });
    });
  });
});
