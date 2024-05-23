import '../server/env';

import { padEnd } from 'lodash';
import moment from 'moment';

import { getGithubHandleFromUrl, getOrg, getRepo, getUser } from '../server/lib/github';
import models, { Op, sequelize } from '../server/models';

function report(collective, context) {
  console.log(
    padEnd(`('${collective.slug}'),`, 32, ' '),
    `-- ${context} ${collective.type} https://opencollective.com/${collective.slug}`,
  );
}

async function checkGithubExists(githubHandle, accessToken) {
  // console.log(`Checking ${githubHandle}`);
  if (githubHandle.includes('/')) {
    // A repository GitHub Handle (most common)
    const repo = await getRepo(githubHandle, accessToken).catch(() => null);
    if (!repo) {
      throw new Error('We could not verify the GitHub repository exists');
    }
  } else {
    // An organization GitHub Handle
    const org = await getOrg(githubHandle, accessToken).catch(() => null);
    if (!org) {
      const user = await getUser(githubHandle, accessToken).catch(() => null);
      if (!user) {
        throw new Error('We could not verify the GitHub organization or user exists');
      }
    }
  }
}

async function run() {
  const collectives = await models.Collective.findAll({
    where: {
      updatedAt: { [Op.gte]: moment().subtract(7, 'days').toDate() },
      repositoryUrl: { [Op.startsWith]: 'https://github.com/' },
      // data: { isBanned: { [Op.not]: true } },
    },
    order: [['updatedAt', 'DESC']],
    limit: 2500,
    paranoid: true,
  });

  for (const collective of collectives) {
    if (collective.data?.isBanned === true || collective.data?.seo === true) {
      continue;
    }

    try {
      await checkGithubExists(getGithubHandleFromUrl(collective.repositoryUrl));
    } catch (err) {
      // console.log(err);
      report(collective, 'NEW');
    }
  }

  await sequelize.close();
}

run();
