import config from 'config';
import { expect } from 'chai';
import sinon from 'sinon';
import { isValidOCImage } from '../../../server/lib/images';

const sandbox = sinon.createSandbox();

describe('server/lib/images', () => {
  describe('isValidOCImage', () => {
    describe('In non-prod environment', () => {
      it('always returns  true', () => {
        expect(isValidOCImage('test')).to.be.true;
      });
    });

    describe('In prod environment', () => {
      beforeEach(() => {
        // Simulate a production environment during the test
        sandbox.stub(config, 'env').value('production');
      });

      afterEach(() => {
        sandbox.restore();
      });

      it('returns true for valid images based on S3 bucket', () => {
        expect(isValidOCImage('https://opencollective-staging.s3-us-west-1.amazonaws.com/image.jpg')).to.be.true;
      });

      it('returns false for invalid images', () => {
        expect(isValidOCImage('test')).to.be.false;
        expect(isValidOCImage('https://malicious-bucket.s3-us-west-1.amazonaws.com/image.jpg')).to.be.false;
      });
    });
  });
});
