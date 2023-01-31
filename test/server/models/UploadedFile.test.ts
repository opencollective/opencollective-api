import { expect } from 'chai';

import models from '../../../server/models';
import { fakeOpenCollectiveS3URL } from '../../test-helpers/fake-data';

describe('server/models/UploadedFile', () => {
  let validParams;

  before(async () => {
    validParams = { kind: 'ACCOUNT_AVATAR', url: fakeOpenCollectiveS3URL(), fileType: 'image/png' };
  });

  describe('create', () => {
    it('should create a new UploadedFile', async () => {
      await models.UploadedFile.create(validParams);
    });

    it('should only allow Open Collective S3 URLs', async () => {
      await expect(models.UploadedFile.create({ ...validParams, url: '' })).to.be.rejectedWith(
        'Validation error: File URL is not valid',
      );
      await expect(
        models.UploadedFile.create({ ...validParams, url: 'https://example.com/invalid-url.png' }),
      ).to.be.rejectedWith('Validation error: File URL is not valid');
    });
  });
});
