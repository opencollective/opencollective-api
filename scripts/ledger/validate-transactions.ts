#!/usr/bin/env ./node_modules/.bin/babel-node

/**
 * A simple wrapper script around `Transaction.validate` to validate a list of transactions.
 */

import '../../server/env';

import { Command } from 'commander';
import { uniq } from 'lodash';

import models, { Op } from '../../server/models';

const program = new Command().description('Helper to validate transactions').arguments('TransactionIds').parse();

const main = async () => {
  const transactionIds = uniq(program.args[0].split(','));
  const transactions = await models.Transaction.findAll({ where: { id: { [Op.in]: transactionIds } } });
  if (transactions.length !== transactionIds.length) {
    throw new Error('Missing transactions');
  }

  for (const transaction of transactions) {
    try {
      await models.Transaction.validate(transaction);
      console.log(`Transaction #${transaction.id} is valid`);
    } catch (e) {
      console.error(`Transaction #${transaction.id} is invalid: ${e.message}`);
    }
  }
};

// Only run script if called directly (to allow unit tests)
if (!module.parent) {
  main()
    .then(() => process.exit(0))
    .catch(e => {
      console.error(e);
      process.exit(1);
    });
}
