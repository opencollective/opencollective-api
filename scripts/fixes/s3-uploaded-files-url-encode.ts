#!/usr/bin/env ./node_modules/.bin/babel-node
import '../../server/env';

import { moveFileInS3 } from '../../server/lib/awsS3';
import { parseToBoolean } from '../../server/lib/utils';
import { sequelize } from '../../server/models';

const IS_DRY = !process.env.DRY ? true : parseToBoolean(process.env.DRY);

const migrate = async () => {
  const files = await sequelize.query(
    `
    SELECT "id", "url"
    FROM "UploadedFiles"
    WHERE "createdAt" BETWEEN '2023-08-22 13:04:59 UTC' AND '2023-08-22 23:58:42 UTC'
    AND TRUE = FALSE -- Uncomment to enable script, added to prevent double run, which would corrupt the URLs
    ORDER BY id DESC
  `,
    {
      type: sequelize.QueryTypes.SELECT,
    },
  );
  for (const file of files) {
    const key = file.url.replace('https://opencollective-production.s3.us-west-1.amazonaws.com/', '');
    const keyParts = key.split('/');
    const lastKeyPart = keyParts.pop();
    const newKey = [...keyParts, decodeURIComponent(lastKeyPart)].join('/');
    const corruptedKey = [...keyParts, encodeURIComponent(lastKeyPart)].join('/');
    const currentURL = `https://opencollective-production.s3.us-west-1.amazonaws.com/${corruptedKey}`;
    if (key !== newKey) {
      console.log(`File: ${file.id}`);
      console.log(`File URL: ${file.url}`);
      console.log(`Actual URL: ${currentURL}`);
      console.log(`Key: ${key}`);
      console.log(`New: ${newKey}`);
      if (!IS_DRY) {
        await moveFileInS3(currentURL, newKey, { ACL: 'public-read' });
        console.log(`File moved to ${file.url}`);
      }
      console.log('---');
    }
  }
};

const main = async () => {
  return migrate();
};

main()
  .then(() => process.exit())
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
