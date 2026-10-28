import '../server/env';

import getUrls from 'get-urls';
import { padEnd } from 'lodash';
import moment from 'moment';

import { resolveRedirect, SPAMMERS_DOMAINS } from '../server/lib/spam';
import type { Collective } from '../server/models';
import models, { Op, sequelize } from '../server/models';

function report(collective: Collective, context: string): void {
  console.log(
    padEnd(`('${collective.slug}'),`, 32, ' '),
    `-- ${context} ${collective.type} https://opencollective.com/${collective.slug}`,
  );
}

async function run(): Promise<void> {
  const collectives = await models.Collective.findAll({
    where: {
      updatedAt: { [Op.gte]: moment().subtract(3, 'month').toDate() },
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
      const parsedUrl = resolveRedirect(new URL(url));
      if (SPAMMERS_DOMAINS.includes(parsedUrl.hostname)) {
        report(collective, 'NEW');
        break;
      }
    }
  }

  await sequelize.close();
}

run();
