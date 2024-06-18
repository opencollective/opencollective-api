import fs from 'fs';
import path from 'path';

import { expect } from 'chai';
import config from 'config';
import exif from 'exif-reader';
import { omit, pick } from 'lodash';
import fetch from 'node-fetch';
import sharp from 'sharp';
import request from 'supertest';

import { fakeUser } from '../../test-helpers/fake-data';
import { startTestServer, stopTestServer } from '../../test-helpers/server';
import * as utils from '../../utils';

const application = utils.data('application');

describe('server/routes/images', () => {
  let user, expressApp;

  before(async function () {
    if (!config.aws.s3.key) {
      console.warn('Skipping images tests because AWS credentials are not set');
      this.skip();
    }

    expressApp = await startTestServer();
    await utils.resetTestDB();
    user = await fakeUser();
  });

  after(async () => {
    await stopTestServer();
  });

  it('should upload a .png image to S3', async () => {
    const originalImage = fs.readFileSync(path.join(__dirname, '../../mocks/images/camera.png'));
    const originalImageWithoutMetadata = (await sharp(originalImage).toBuffer()).toString();

    const res = await request(expressApp)
      .post(`/images/?api_key=${application.api_key}`)
      .attach('file', 'test/mocks/images/camera.png')
      .field('kind', 'ACCOUNT_AVATAR')
      .set('Authorization', `Bearer ${user.jwt()}`);

    expect(res.status).to.eq(200);
    expect(res.body.url).to.contain('.png');
    expect(res.body.url).to.match(/\/account-avatar\/[\w-]{36}\/camera.png/);
    const fetchedFile = await fetch(res.body.url).then(res => res.text());
    expect(fetchedFile).to.equal(originalImageWithoutMetadata);
  });

  it('should upload a .webp image to S3', async () => {
    const originalImage = fs.readFileSync(path.join(__dirname, '../../mocks/images/plain.webp'));
    const originalImageWithoutMetadata = (await sharp(originalImage).toBuffer()).toString();

    const res = await request(expressApp)
      .post(`/images/?api_key=${application.api_key}`)
      .attach('file', 'test/mocks/images/plain.webp')
      .field('kind', 'ACCOUNT_LONG_DESCRIPTION')
      .set('Authorization', `Bearer ${user.jwt()}`);

    expect(res.status).to.eq(200);
    expect(res.body.url).to.contain('.webp');
    expect(res.body.url).to.match(/\/account-long-description\/[\w-]{36}\/plain.webp/);
    const fetchedFile = await fetch(res.body.url).then(res => res.text());
    expect(fetchedFile).to.equal(originalImageWithoutMetadata);
  });

  describe('fileName', () => {
    it('can be overwritten', async () => {
      const res = await request(expressApp)
        .post(`/images/?api_key=${application.api_key}`)
        .attach('file', 'test/mocks/images/camera.png')
        .field('kind', 'ACCOUNT_AVATAR')
        .field('fileName', 'another-name')
        .set('Authorization', `Bearer ${user.jwt()}`);

      expect(res.status).to.eq(200);
      expect(res.body.url).to.match(/\/account-avatar\/[\w-]{36}\/another-name.png/);
    });

    it('sanitizes relative path', async () => {
      const res = await request(expressApp)
        .post(`/images/?api_key=${application.api_key}`)
        .attach('file', 'test/mocks/images/camera.png')
        .field('kind', 'ACCOUNT_AVATAR')
        .field('fileName', '../../another-name')
        .set('Authorization', `Bearer ${user.jwt()}`);

      expect(res.status).to.eq(200);
      expect(res.body.url).to.match(/\/account-avatar\/[\w-]{36}\/another-name.png/);
    });

    it('sanitizes malicious content', async () => {
      const res = await request(expressApp)
        .post(`/images/?api_key=${application.api_key}`)
        .attach('file', 'test/mocks/images/camera.png')
        .field('kind', 'ACCOUNT_AVATAR')
        .field('fileName', '~/.\u0000ssh/authorized_keys')
        .set('Authorization', `Bearer ${user.jwt()}`);

      expect(res.status).to.eq(200);
      expect(res.body.url).to.match(/\/account-avatar\/[\w-]{36}\/authorized_keys.png/);
    });
  });

  it('should strip EXIF data from image but save it in DB', async () => {
    const otherMetadataFields = ['exif', 'xmp', 'iptc', 'icc'];
    const originalFile = sharp('test/mocks/images/exif.jpg');
    const originalMetadata = await originalFile.metadata();
    const originalExif = exif(originalMetadata.exif);
    const imageMetadata = {
      format: 'jpeg',
      width: 200,
      height: 300,
      space: 'srgb',
      channels: 3,
      depth: 'uchar',
      density: 300,
      chromaSubsampling: '4:4:4',
      isProgressive: false,
      resolutionUnit: 'inch',
      hasProfile: false,
      hasAlpha: false,
      orientation: 5,
    };

    expect(omit(originalMetadata, otherMetadataFields)).to.containSubset(imageMetadata);
    expect(originalExif).to.containSubset({
      bigEndian: false,
      Image: {
        ImageDescription: 'Created with GIMP',
        Orientation: 5,
        XResolution: 300,
        YResolution: 300,
        ResolutionUnit: 2,
        Software: 'GIMP 2.10.36',
        ExifTag: 190,
        GPSTag: 270,
      },
      Thumbnail: {
        NewSubfileType: 1,
        ImageWidth: 256,
        ImageLength: 170,
        BitsPerSample: [8, 8, 8],
        Compression: 6,
        PhotometricInterpretation: 6,
        SamplesPerPixel: 3,
        XResolution: 72,
        YResolution: 72,
        ResolutionUnit: 2,
        JPEGInterchangeFormat: 540,
        JPEGInterchangeFormatLength: 3282,
      },
      Photo: {
        ColorSpace: 1,
      },
      GPSInfo: {
        GPSLatitude: [0, 0, 0],
        GPSLongitude: [0, 0, 0],
        GPSAltitude: 250,
      },
    });

    const res = await request(expressApp)
      .post(`/images/?api_key=${application.api_key}`)
      .attach('file', 'test/mocks/images/exif.jpg')
      .field('kind', 'ACCOUNT_AVATAR')
      .set('Authorization', `Bearer ${user.jwt()}`);

    expect(res.status).to.eq(200);
    expect(res.body.url).to.contain('.jpg');
    expect(res.body.url).to.match(/\/account-avatar\/[\w-]{36}\/exif.jpg/);
    const fetchedFile = await fetch(res.body.url).then(res => res.buffer());
    const fetchedImage = await sharp(fetchedFile);
    const fetchedFileMetadata = await fetchedImage.metadata();
    expect(fetchedFileMetadata).to.containSubset(pick(imageMetadata, ['channels', 'depth', 'format', 'hasAlpha'])); // Some file metadata shouldn't be changed
    expect(fetchedFileMetadata.width).to.eq(300); // We've rotated the image
    expect(fetchedFileMetadata.height).to.eq(200); // We've rotated the image
    expect(fetchedFileMetadata.exif).to.be.undefined;

    // Make sure other metadata is stripped as well
    for (const field of otherMetadataFields) {
      expect(fetchedFileMetadata[field]).to.be.undefined;
    }
  });

  it('should throw an error if no file field is sent', async () => {
    const res = await request(expressApp)
      .post(`/images/?api_key=${application.api_key}`)
      .field('kind', 'ACCOUNT_AVATAR')
      .set('Authorization', `Bearer ${user.jwt()}`);

    expect(res.status).to.eq(400);
    expect(res.body.error).to.deep.eq({
      code: 400,
      type: 'missing_required',
      message: 'Missing required fields',
      fields: { file: 'File field is required and missing' },
    });
  });

  it('should throw an error if file type is invalid', async () => {
    const res = await request(expressApp)
      .post(`/images/?api_key=${application.api_key}`)
      .attach('file', 'test/mocks/data.js')
      .field('kind', 'ACCOUNT_AVATAR')
      .set('Authorization', `Bearer ${user.jwt()}`);

    expect(res.status).to.eq(400);
    expect(res.body.error).to.deep.eq({
      code: 400,
      message:
        'Mimetype of the file should be one of: image/png, image/jpeg, image/gif, image/webp, application/pdf, text/csv',
      type: 'INVALID_FILE_MIME_TYPE',
      fields: {
        file: 'Mimetype of the file should be one of: image/png, image/jpeg, image/gif, image/webp, application/pdf, text/csv',
      },
    });
  });

  // Kind

  it('should throw an error if kind is missing', async () => {
    const res = await request(expressApp)
      .post(`/images/?api_key=${application.api_key}`)
      .attach('file', 'test/mocks/images/camera.png')
      .set('Authorization', `Bearer ${user.jwt()}`);

    expect(res.status).to.eq(400);
    expect(res.body.error).to.deep.eq({
      code: 400,
      type: 'missing_required',
      message: 'Missing required fields',
      fields: { kind: 'Kind field is required and missing' },
    });
  });

  it('should throw an error if kind is invalid', async () => {
    const res = await request(expressApp)
      .post(`/images/?api_key=${application.api_key}`)
      .attach('file', 'test/mocks/images/camera.png')
      .field('kind', '???')
      .set('Authorization', `Bearer ${user.jwt()}`);

    expect(res.status).to.eq(400);
    expect(res.body.error).to.deep.eq({
      code: 400,
      type: 'INVALID_FILE_KIND',
      message:
        'Kind should be one of: ACCOUNT_AVATAR, ACCOUNT_BANNER, EXPENSE_ATTACHED_FILE, EXPENSE_ITEM, TRANSACTIONS_IMPORT, ACCOUNT_LONG_DESCRIPTION, UPDATE, COMMENT, TIER_LONG_DESCRIPTION, ACCOUNT_CUSTOM_EMAIL, AGREEMENT_ATTACHMENT',
      fields: {
        kind: 'Kind should be one of: ACCOUNT_AVATAR, ACCOUNT_BANNER, EXPENSE_ATTACHED_FILE, EXPENSE_ITEM, TRANSACTIONS_IMPORT, ACCOUNT_LONG_DESCRIPTION, UPDATE, COMMENT, TIER_LONG_DESCRIPTION, ACCOUNT_CUSTOM_EMAIL, AGREEMENT_ATTACHMENT',
      },
    });
  });

  // Misc

  it('should not upload if the user is not logged in', async () => {
    const res = await request(expressApp)
      .post(`/images/?api_key=${application.api_key}`)
      .attach('file', 'test/mocks/images/camera.png')
      .field('kind', 'ACCOUNT_AVATAR');

    expect(res.status).to.eq(401);
  });
});
