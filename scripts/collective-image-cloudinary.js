import '../server/env';

import fetch from 'node-fetch';

import { FileKind } from '../server/constants/file-kind';
import models, { Op } from '../server/models';
import UploadedFile from '../server/models/UploadedFile';

async function main() {
  const collectives = await models.Collective.findAll({
    where: { image: { [Op.iLike]: 'https://res.cloudinary.com/opencollective/%' } },
  });
  for (const collective of collectives) {
    const image = await fetch(collective.image);
    const file = { buffer: image.buffer() }; // TODO: complete that
    const uploadedFile = await UploadedFile.upload(file, FileKind.ACCOUNT_AVATAR);
    collective.update({ image: uploadedFile.url });
  }
  console.log('Done.');
}

main();
