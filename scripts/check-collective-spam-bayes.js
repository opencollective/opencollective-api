#!/usr/bin/env node
import '../server/env';

import geoip from 'geoip-lite'; // eslint-disable-line node/no-unpublished-import
import { get, padEnd } from 'lodash';
import moment from 'moment';

import { collectiveBayesCheck } from '../server/lib/spam';
import models, { Op, sequelize } from '../server/models';

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

function report(collective, context) {
  console.log(
    padEnd(`('${collective.slug}'),`, 32, ' '),
    `-- ${context} ${collective.type} https://opencollective.com/${collective.slug}`,
  );
}

async function run() {
  const collectives = await models.Collective.findAll({
    where: {
      approvedAt: { [Op.is]: null },
      [Op.or]: [
        { description: { [Op.not]: null } },
        { longDescription: { [Op.not]: null } },
        { website: { [Op.not]: null } },
      ],
      // [Op.or]: [
      //   { name: { [Op.iLike]: '%keto%' } },
      //   { slug: { [Op.iLike]: '%keto%' } },
      //   { description: { [Op.iLike]: '%keto%' } },
      //   { longDescription: { [Op.iLike]: '%keto%' } },
      //   { website: { [Op.iLike]: '%keto%' } },
      // ],
      updatedAt: { [Op.gte]: moment().subtract(7, 'days').toDate() },
      // createdAt: { [Op.gt]: '2020-06-01', [Op.lte]: '2020-06-11' },
    },
    order: [['updatedAt', 'DESC']],
    paranoid: true,
  });

  for (const collective of collectives) {
    // console.log(collective.slug);

    const ipString = await getIpString(collective);

    const bayesResult = await collectiveBayesCheck(collective, ipString);
    if (bayesResult === 'spam' && collective.data?.isBanned === true) {
      // console.log('HIT', `https://opencollective.com/${collective.slug}`);
    } else if (collective.data?.isBanned === true) {
      // console.log('MISS', `https://opencollective.com/${collective.slug}`);
    }

    if (
      bayesResult === 'spam' &&
      collective.data?.isBanned !== true &&
      collective.data?.seo !== true &&
      collective.data?.notSpam !== true
    ) {
      const transactions = await collective.getTransactions({});
      if (transactions.length === 0) {
        let skip = false;
        const admins = await collective.getAdmins();
        for (const admin of admins) {
          const adminTransactions = await admin.getTransactions({});
          if (adminTransactions.length === 0) {
            report(admin, 'ADMIN BY');
          } else {
            skip = true;
          }
        }
        if (collective.type == 'USER') {
          const accounts = await collective.getMemberships({ role: 'ADMIN' });
          for (const account of accounts) {
            const accountTransactions = await account.getTransactions({});
            if (accountTransactions.length === 0) {
              report(account, 'ADMIN FROM');
            } else {
              skip = true;
            }
          }
        }
        if (!skip) {
          report(collective, 'NEW');
        } else {
          // report(collective, 'SKIP');
        }
      } else {
        // report.log(collective, 'HAS_TRANSACTIONS');
      }
    }
  }

  await sequelize.close();
}

run();
