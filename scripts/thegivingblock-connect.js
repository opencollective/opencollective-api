import '../server/env.js';

import config from 'config';

import models, { sequelize } from '../server/models/index.js';
import { login } from '../server/paymentProviders/thegivingblock/index.js';

const HOST_ID = process.env.HOST_ID || 11004;

async function run() {
  const username = config.thegivingblock.username;
  const password = config.thegivingblock.password;

  const accountProperties = { CollectiveId: HOST_ID, username, service: 'thegivingblock' };

  let account = await models.ConnectedAccount.findOne({
    where: accountProperties,
  });
  if (!account) {
    account = await models.ConnectedAccount.create(accountProperties);
  }

  await login(username, password, account);

  await sequelize.close();
  process.exit(0);
}

run();
