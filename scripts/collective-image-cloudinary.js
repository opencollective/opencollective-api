import '../server/env';

import models, { Op } from '../server/models';
import UploadedFile from '../server/models/UploadedFile';

async function main() {
  const collectives = await models.Collective.findAll({
    where: { image: { [Op.iLike]: 'https://res.cloudinary.com/opencollective/%' } },
  });

  for (const collective of collectives) {
    console.log(`Processing ${collective.slug} (${collective.id})`);
    try {
      const response = await fetch(collective.image);
      // Alternative
      // const response = await fetch(`https://images.opencollective.com/${collective.slug}/logo/256.png`);
      const buffer = Buffer.from(await response.arrayBuffer());
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
    } catch (e) {
      console.log(e);
    }
  }

  console.log('Done.');
}

main();
