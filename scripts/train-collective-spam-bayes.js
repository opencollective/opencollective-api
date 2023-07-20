#!/usr/bin/env node
import url from 'url';
const __dirname = url.fileURLToPath(new url.URL('.', import.meta.url));
import '../server/env.js';

import fs from 'fs';
import path from 'path';

import bayes from 'bayes';
import geoip from 'geoip-lite'; // eslint-disable-line node/no-unpublished-import
import { get } from 'lodash-es';

import { collectiveBayesContent } from '../server/lib/spam.js';
import models, { Op, sequelize } from '../server/models/index.js';

const classifier = bayes();

async function getIpString(collective) {
  let user = await models.User.findByPk(collective.CreatedByUserId, { paranoid: false });
  if (!user) {
    const adminUsers = await collective.getAdminUsers({ paranoid: false });
    if (adminUsers.length > 0) {
      user = adminUsers[0];
    }
  }
  if (user) {
    const ip = get(user, 'data.lastSignInRequest.ip', get(user, 'data.creationRequest.ip'));
    if (ip) {
      const geoipLookup = geoip.lookup(ip);
      if (geoipLookup) {
        return `${geoipLookup.city}, ${geoipLookup.country}`;
      }
    }
  }
}

async function run() {
  const collectives = await models.Collective.findAll({
    where: {
      approvedAt: { [Op.is]: null },
      longDescription: { [Op.not]: null },
      createdAt: { [Op.gt]: '2020-06-01' },
    },
    order: [['createdAt', 'DESC']],
    paranoid: false,
  });

  for (const collective of collectives) {
    console.log(collective.slug, collective.createdAt);
    const ipString = await getIpString(collective);
    const content = await collectiveBayesContent(collective, ipString);

    if (collective.data?.isBanned || collective.data?.seo === true) {
      await classifier.learn(content, 'spam');
    } else {
      await classifier.learn(content, 'ham');
    }
  }

  // Extra Ham, yummy
  const approvedCollectives = await models.Collective.findAll({
    where: {
      approvedAt: { [Op.not]: null },
      longDescription: { [Op.not]: null },
    },
    order: [['createdAt', 'DESC']],
  });

  for (const collective of approvedCollectives) {
    console.log(collective.slug, collective.createdAt);
    const ipString = await getIpString(collective);
    const content = await collectiveBayesContent(collective, ipString);

    await classifier.learn(content, 'ham');
  }

  const bayesClassifierPath = path.join(__dirname, '..', 'config', `collective-spam-bayes.json`);
  fs.writeFileSync(bayesClassifierPath, JSON.stringify(JSON.parse(classifier.toJson()), null, 2));

  await sequelize.close();
}

run();
