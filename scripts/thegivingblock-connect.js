import '../server/env';

import config from 'config';

import models from '../server/models';
import { login } from '../server/paymentProviders/thegivingblock';

const HOST_ID = process.env.HOST_ID || 9805;

async function run() {
  const username = config.thegivingblock.username;
  const password = config.thegivingblock.password;

  let account = await models.ConnectedAccount.findOne({
    where: { CollectiveId: HOST_ID, username, service: 'thegivingblock' },
  });
  if (!account) {
    account = await models.ConnectedAccount.create({
      where: { CollectiveId: HOST_ID, username, service: 'thegivingblock' },
    });
  }

  await login(username, password, account);
}

run();
