#!/usr/bin/env ./node_modules/.bin/babel-node
/* eslint-disable camelcase */

import '../server/env';

import { toNumber } from 'lodash';

import { Service as ConnectedAccountServices } from '../server/constants/connected_account';
import { crypto } from '../server/lib/encryption';
import { listCards } from '../server/lib/privacy';
import models, { sequelize } from '../server/models';
import { PayoutMethodTypes } from '../server/models/PayoutMethod';

const run = async (CollectiveId, cardToken, _details) => {
  const existing = await models.PayoutMethod.findOne({
    where: {
      type: PayoutMethodTypes.CREDIT_CARD,
      data: { token: cardToken },
    },
  });
  if (existing) {
    throw new Error(`Credit card ${cardToken} is already attached to collective ${existing.CollectiveId}`);
  }

  const collective = await models.Collective.findByPk(toNumber(CollectiveId));
  if (!collective) {
    throw new Error(`Couldn't find collective ${CollectiveId}`);
  }
  const host = await collective.getHostCollective();
  if (!host) {
    throw new Error(`Collective ${CollectiveId} has no host`);
  }

  const connectedAccount = await models.ConnectedAccount.findOne({
    where: { service: ConnectedAccountServices.PRIVACY, CollectiveId: host.id },
  });
  if (!connectedAccount) {
    throw new Error(`${host.slug} is not connected to Privacy.`);
  }

  const [card] = await listCards(connectedAccount.token, cardToken);
  if (!card) {
    throw new Error(`Couldn't find virtual credit card ${cardToken}`);
  }

  const details = _details && crypto.encrypt(JSON.stringify(_details));

  await models.PayoutMethod.create({
    CollectiveId,
    data: { token: cardToken, details },
    name: card.last_four,
    type: PayoutMethodTypes.CREDIT_CARD,
  });

  console.log(`Successfully added ${cardToken} to collective ${CollectiveId}!`);
};

if (!module.parent) {
  if (process.argv.length < 4 || process.argv[2] == 'help') {
    console.log(
      '\nUsage:\n  npm run script ./scripts/encrypt.js collectiveId credit-card-token [pan cvv exp_month exp_year]\n',
    );
    process.exit(0);
  }

  const [, , CollectiveId, cardToken, pan, cvv, exp_month, exp_year] = process.argv;
  const details = pan && { pan, cvv, exp_month, exp_year };
  run(CollectiveId, cardToken, details)
    .catch(async e => {
      console.error(e.toString());
      await sequelize.close();
      process.exit(1);
    })
    .then(() => sequelize.close());
}
