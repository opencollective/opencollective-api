import { expect } from 'chai';
import sinon from 'sinon';

import { deprecateClearbitLogos } from '../../../scripts/fixes/deprecate-clearbit-logos';
import { UploadedFile } from '../../../server/models';
import { fakeCollective } from '../../test-helpers/fake-data';
import { resetTestDB } from '../../utils';

describe('scripts/fixes/deprecate-clearbit-logos', () => {
  beforeEach(async () => {
    await resetTestDB();
  });
  it('Downloads and store organization clearbit logos', async () => {
    const colWithClearbitImage = await fakeCollective({
      image: 'https://logo.clearbit.com/opencollective.com',
      data: {
        existingDataKey: 123,
      },
    });
    const colWithClearbitImageData = colWithClearbitImage.data;

    const colWithClearbitImage2 = await fakeCollective({
      image: 'https://logo.clearbit.com/google.com',
      data: {
        existingDataKey: 123,
      },
    });
    const colWithClearbitImage2Data = colWithClearbitImage2.data;

    const colWithoutClearbitImage = await fakeCollective({
      image: 'https://opencollective.com',
    });

    const clearbitImageGetterMock = sinon.stub().callsFake(() => {
      return {
        buffer: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQAAAAA3bvkkAAAACklEQVR4AWNgAAAAAgABc3UBGAAAAABJRU5ErkJggg==',
          'base64',
        ),
        size: 67,
        mimetype: 'image/png',
        originalname: null,
      };
    });

    await deprecateClearbitLogos({ pageSize: 1, clearbitImageGetter: clearbitImageGetterMock, logger: console.log });

    expect(clearbitImageGetterMock).to.be.have.callCount(2);
    expect(clearbitImageGetterMock).to.have.been.calledWith('https://logo.clearbit.com/opencollective.com');
    expect(clearbitImageGetterMock).to.have.been.calledWith('https://logo.clearbit.com/google.com');

    await colWithClearbitImage.reload();
    await colWithClearbitImage2.reload();
    await colWithoutClearbitImage.reload();

    expect(colWithClearbitImage.image).to.not.eq('https://logo.clearbit.com/opencollective.com');
    expect(colWithClearbitImage2.image).to.not.eq('https://logo.clearbit.com/google.com');
    expect(colWithoutClearbitImage.image).to.eq('https://opencollective.com');

    expect(UploadedFile.isOpenCollectiveS3BucketURL(colWithClearbitImage.image));
    expect(UploadedFile.isOpenCollectiveS3BucketURL(colWithClearbitImage2.image));
    expect(UploadedFile.isOpenCollectiveS3BucketURL(colWithoutClearbitImage.image));

    expect(colWithClearbitImage.data).to.eql({
      ...colWithClearbitImageData,
      migration20251020ClearbitLogo: 'https://logo.clearbit.com/opencollective.com',
    });
    expect(colWithClearbitImage2.data).to.eql({
      ...colWithClearbitImage2Data,
      migration20251020ClearbitLogo: 'https://logo.clearbit.com/google.com',
    });
  });
});
