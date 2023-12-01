import '../server/env';

import fetch from 'node-fetch';

import models, { Op } from '../server/models';
import UploadedFile from '../server/models/UploadedFile';

async function main() {
  const collectives = await models.Collective.findAll({
    where: { image: { [Op.iLike]: 'https://res.cloudinary.com/opencollective/%' } },
  });

  for (const collective of collectives) {
    const response = await fetch(collective.image);
    const buffer = await response.buffer();
    const size = buffer.byteLength;
    const mimetype = response.headers.get('Content-Type') || 'unknown';
    const originalname = response.url.split('/').pop() || 'unknown';
    const file = {
      buffer,
      size,
      mimetype,
      originalname,
    };
    const uploadedFile = await UploadedFile.upload(file, 'ACCOUNT_AVATAR');
    await collective.update({ image: uploadedFile.url });
  }

  console.log('Done.');
}

main();
