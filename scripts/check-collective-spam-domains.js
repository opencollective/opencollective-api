#!/usr/bin/env node
import '../server/env';

import getUrls from 'get-urls'; // eslint-disable-line node/no-unpublished-import

import { SPAMMERS_DOMAINS } from '../server/lib/spam';
import models, { Op, sequelize } from '../server/models';

async function run() {
  const collectives = await models.Collective.findAll({
    where: {
      updatedAt: { [Op.gt]: '2020-11-01' },
    },
    order: [['updatedAt', 'DESC']],
    paranoid: true,
  });

  for (const collective of collectives) {
    if (collective.data?.isBanned === true || collective.data?.seo === true) {
      continue;
    }

    const content = `${collective.slug} ${collective.name} ${collective.description} ${collective.longDescription} ${collective.website}`;
    const urls = getUrls(content);
    for (const url of urls) {
      const parsedUrl = new URL(url);
      if (SPAMMERS_DOMAINS.includes(parsedUrl.hostname)) {
        console.log(
          'NEW',
          collective.slug,
          `https://opencollective.com/${collective.slug}`,
          collective.createdAt,
          parsedUrl.hostname,
        );
        continue;
      }
    }
  }

  await sequelize.close();
}

run();
