#!/usr/bin/env node
import '../server/env.js';

import { get, padEnd, uniq } from 'lodash-es';
import moment from 'moment';

import models, { Op, sequelize } from '../server/models/index.js';

function report(collective, context) {
  console.log(
    padEnd(`('${collective.slug}'),`, 32, ' '),
    `-- ${context} ${collective.type} https://opencollective.com/${collective.slug}`,
  );
}

async function run() {
  const bannedCollectives = await models.Collective.findAll({
    where: {
      data: { isBanned: true },
      updatedAt: { [Op.gte]: moment().subtract(1, 'week').toDate() },
    },
    order: [['updatedAt', 'DESC']],
    paranoid: false,
  });

  let ips = [];

  for (const collective of bannedCollectives) {
    console.log(collective.slug, collective.updatedAt);
    const adminUsers = await collective.getAdminUsers({ paranoid: false });
    for (const user of adminUsers) {
      const lastSignInRequestIp = get(user, 'data.lastSignInRequest.ip');
      if (lastSignInRequestIp) {
        ips.push(lastSignInRequestIp);
      }
      const creationRequestIp = get(user, 'data.creationRequest.ip');
      if (creationRequestIp) {
        ips.push(creationRequestIp);
      }
    }
  }

  ips = uniq(ips).filter(ip => !ip.startsWith('::ffff:'));

  const users = await models.User.findAll({
    where: {
      [Op.or]: [
        { data: { lastSignInRequest: { ip: { [Op.in]: ips } } } },
        { data: { creationRequest: { ip: { [Op.in]: ips } } } },
      ],
      updatedAt: { [Op.gte]: moment().subtract(3, 'month').toDate() },
    },
    order: [['updatedAt', 'DESC']],
    paranoid: true,
  });

  for (const user of users) {
    const collective = await models.Collective.findByPk(user.CollectiveId);

    const transactions = await collective.getTransactions({});
    if (transactions.length === 0) {
      let skip = false;
      const accounts = await collective.getMemberships({ role: 'ADMIN' });
      for (const account of accounts) {
        const accountTransactions = await account.getTransactions({});
        if (accountTransactions.length === 0) {
          report(account, 'ADMIN FROM');
        } else {
          skip = true;
        }
      }
      if (!skip) {
        report(collective, 'NEW');
      } else {
        // report(collective, 'SKIP');
      }
    }
  }

  await sequelize.close();
}

run();
