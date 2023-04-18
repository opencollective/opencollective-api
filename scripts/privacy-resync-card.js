#!/usr/bin/env ./node_modules/.bin/babel-node
/* eslint-disable camelcase */

import '../server/env';

import moment from 'moment';

import { Service as ConnectedAccountServices } from '../server/constants/connected_account';
import * as privacyLib from '../server/lib/privacy';
import models, { sequelize } from '../server/models';
import privacy from '../server/paymentProviders/privacy';

const run = async cardId => {
  const card = await models.VirtualCard.findByPk(cardId, { include: ['host'] });
  const connectedAccount = await models.ConnectedAccount.findOne({
    where: { service: ConnectedAccountServices.PRIVACY, CollectiveId: card.HostCollectiveId },
  });
  const expenses = await models.Expense.findAll({ where: { VirtualCardId: card.id } });
  const { data: privacyTransaction } = await privacyLib.listTransactions(
    connectedAccount.token,
    card.id,
    {
      begin: moment(process.env.BEGIN || card.createdAt).toISOString(),
      // eslint-disable-next-line camelcase
      page_size: 500,
    },
    'approvals',
  );
  for (const pt of privacyTransaction) {
    const expense = expenses.find(c => c.data.token === pt.token);
    if (expense) {
      console.log(`Charge ${pt.token} from ${pt.created} synced as expense ${expense.id}`);
    } else {
      const transaction = await models.Transaction.findOne({ where: { data: { token: pt.token } } });
      if (transaction) {
        console.log(`Charge ${pt.token} from ${pt.created} synced in transaction ${transaction.id}`);
      } else {
        console.log(`Charge ${pt.token} from ${pt.created} not synced`);
        console.log(pt);
        await privacy.processTransaction(pt, undefined, { card });
      }
    }
  }

  await sequelize.close();
  process.exit(0);
};

if (!module.parent) {
  if (process.argv.length < 3 || process.argv[2] === 'help') {
    console.log('\nUsage:\n  npm run script ./scripts/privacy-resync-card.js cardId\n');
    process.exit(0);
  }

  const [, , cardId] = process.argv;
  run(cardId);
}
