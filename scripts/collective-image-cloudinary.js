import '../server/env';

import models, { Op, sequelize } from '../server/models';
import UploadedFile from '../server/models/UploadedFile';

const DRY_RUN = process.env.DRY_RUN !== 'false';

const FIELDS = [
  { name: 'image', kind: 'ACCOUNT_AVATAR' },
  { name: 'backgroundImage', kind: 'ACCOUNT_BANNER' },
];

const isCloudinaryUrl = url => {
  try {
    const { hostname } = new URL(url);
    return hostname === 'cloudinary.com' || hostname.endsWith('.cloudinary.com');
  } catch {
    return false;
  }
};

async function main() {
  console.log(`Running in ${DRY_RUN ? 'DRY RUN' : 'REAL RUN'} mode`);

  for (const { name, kind } of FIELDS) {
    const collectives = await models.Collective.findAll({
      where: { [name]: { [Op.iLike]: '%cloudinary.com%' } },
    });

    for (const collective of collectives) {
      const url = collective[name];
      console.log(`Processing ${name} for ${collective.slug} (${collective.id}): ${url}`);
      if (!isCloudinaryUrl(url)) {
        console.log('Skipping, not hosted on Cloudinary');
        continue;
      }
      try {
        const response = await fetch(url);
        if (!response.ok) {
          console.log(`Skipping, source returned ${response.status}`);
          continue;
        }
        const buffer = Buffer.from(await response.arrayBuffer());
        const size = buffer.byteLength;
        const mimetype = (response.headers.get('Content-Type') || 'unknown').split(';')[0].trim();
        const originalname = new URL(response.url).pathname.split('/').pop() || 'unknown';
        console.log(`Fetched ${originalname} (${mimetype}, ${size} bytes)`);
        if (DRY_RUN) {
          continue;
        }
        const file = {
          buffer,
          size,
          mimetype,
          originalname,
        };
        const uploadedFile = await UploadedFile.upload(file, kind, null);
        await collective.update({ [name]: uploadedFile.url });
        console.log(`Updated to ${uploadedFile.url}`);
      } catch (e) {
        console.log(e);
      }
    }
  }

  console.log('Done.');
  await sequelize.close();
}

main();
