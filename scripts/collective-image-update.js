import '../server/env.js';

import models, { Op } from '../server/models/index.js';

async function main() {
  const collectives = await models.Collective.findAll({
    where: { image: { [Op.eq]: null } },
  });
  for (const collective of collectives) {
    if (collective.type === 'USER') {
      const user = await collective.getUser();
      await collective.findImageForUser(user);
    } else {
      await collective.findImage();
    }
  }
  console.log('Done.');
}

main();
