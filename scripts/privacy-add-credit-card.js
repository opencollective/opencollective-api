#!/usr/bin/env ./node_modules/.bin/babel-node
/* eslint-disable camelcase */

import '../server/env';

import { toNumber } from 'lodash';

import models, { sequelize } from '../server/models';
import privacy from '../server/paymentProviders/privacy';

const run = async (CollectiveId, cardNumber, expireDate, cvv) => {
  const collective = await models.Collective.findByPk(toNumber(CollectiveId));
  const host = await collective.getHostCollective();

  await privacy.assignCardToCollective({ cardNumber, expireDate, cvv }, collective, host, { upsert: true });
  console.log('Done!');
  await sequelize.close();
  process.exit(0);
};

if (!module.parent) {
  if (process.argv.length < 4 || process.argv[2] === 'help') {
    console.log(
      '\nUsage:\n  npm run script ./scripts/encrypt.js collectiveId "xxxx  xxxx  xxxx  xxxx" "mm/yyyy" "cvv"\n',
    );
    process.exit(0);
  }

  const [, , CollectiveId, cardNumber, expireDate, cvv] = process.argv;

  if (!CollectiveId || !cardNumber || !expireDate || !cvv) {
    console.error('VirtualCard missing cardNumber, expireDate and/or cvv');
    process.exit(1);
  }

  run(CollectiveId, cardNumber, expireDate, cvv);
}
