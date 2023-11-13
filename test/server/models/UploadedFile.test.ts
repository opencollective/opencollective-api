import { expect } from 'chai';

import models from '../../../server/models';
import { fakeOpenCollectiveS3URL } from '../../test-helpers/fake-data';

describe('server/models/UploadedFile', () => {
  let validParams;

  beforeEach(async () => {
    validParams = {
      kind: 'ACCOUNT_AVATAR',
      url: fakeOpenCollectiveS3URL(),
      fileType: 'image/png',
      fileName: 'test.png',
    };
  });

  describe('create', () => {
    it('should create a new UploadedFile', async () => {
      await models.UploadedFile.create(validParams);
    });

    it('should only allow Open Collective S3 URLs', async () => {
      await expect(models.UploadedFile.create({ ...validParams, url: '' })).to.be.rejectedWith(
        'Validation error: File URL is not a valid URL,\nValidation error: Validation notEmpty on url failed',
      );
      await expect(
        models.UploadedFile.create({ ...validParams, url: 'https://example.com/invalid-url.png' }),
      ).to.be.rejectedWith('Validation error: File URL is not valid');
    });

    describe('filename', () => {
      it('can be null', async () => {
        await models.UploadedFile.create({ ...validParams, fileName: null });
      });

      it('is set to null if empty', async () => {
        const file = await models.UploadedFile.create({ ...validParams, fileName: '' });
        expect(file.fileName).to.be.null;
      });

      it('must include file extension if set', async () => {
        await expect(models.UploadedFile.create({ ...validParams, fileName: 'invalid' })).to.be.rejectedWith(
          'Validation error: File name must have an extension',
        );
      });

      it('can be up to 1024 characters if set', async () => {
        await models.UploadedFile.create({ ...validParams, fileName: `${'a'.repeat(1020)}.jpg` });
      });

      it('must be at most 1024 characters if set', async () => {
        await expect(models.UploadedFile.create({ ...validParams, fileName: 'a'.repeat(1025) })).to.be.rejectedWith(
          'Validation error: File name cannot exceed 1024 characters',
        );
      });
    });
  });
});
