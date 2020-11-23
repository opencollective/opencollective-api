#!/usr/bin/env node
import '../server/env';

import geoip from 'geoip-lite'; // eslint-disable-line node/no-unpublished-import
import { get } from 'lodash';

import { collectiveBayesCheck } from '../server/lib/spam';
import models, { Op, sequelize } from '../server/models';

async function getIpString(collective) {
  let user = await models.User.findByPk(collective.CreatedByUserId, { paranoid: false });
  if (!user) {
    const adminUsers = await collective.getAdminUsers();
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
      [Op.or]: [
        { description: { [Op.not]: null } },
        { longDescription: { [Op.not]: null } },
        // { website: { [Op.not]: null } },
      ],
      updatedAt: { [Op.gt]: '2020-11-15' },
    },
    order: [['updatedAt', 'DESC']],
    paranoid: true,
  });

  for (const collective of collectives) {
    const ipString = await getIpString(collective);

    const bayesResult = await collectiveBayesCheck(collective, ipString);
    if (bayesResult === 'spam' && collective.data?.isBanned === true) {
      // console.log('HIT', `https://opencollective.com/${collective.slug}`);
    } else if (collective.data?.isBanned === true) {
      // console.log('MISS', `https://opencollective.com/${collective.slug}`);
    }

    if (bayesResult === 'spam' && collective.data?.isBanned !== true && collective.data?.seo !== true) {
      console.log('NEW', collective.slug, `https://opencollective.com/${collective.slug}`, collective.createdAt);
      // console.log(collective.slug);
    }
  }

  await sequelize.close();
}

run();
