#!/usr/bin/env ./node_modules/.bin/babel-node
import '../../server/env';

import { toNumber } from 'lodash';

import { refundTransaction } from '../../server/lib/payments';
import models from '../../server/models';

const IS_DRY = !!process.env.DRY;

const refund = async transactionId => {
  const transaction = await models.Transaction.findByPk(transactionId);
  if (!transaction) {
    throw new Error(`Could not find transaction #${transactionId}`);
  }

  /* Refund both charge & application fee */
  if (!IS_DRY) {
    await refundTransaction(transaction, null, 'Refund transaction');
  }
};

const main = async () => {
  if (IS_DRY) {
    console.info('RUNNING IN DRY MODE!');
  }
  const transactionId = toNumber(process.argv[2]);
  if (!transactionId) {
    console.log('Usage npm run script scripts/fixes/refund-transaction.ts transactionId');
  } else {
    console.log(`Refunding transaction #${transactionId}...`);
    await refund(transactionId);
  }
};

main()
  .then(() => process.exit())
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
