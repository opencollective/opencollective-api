#!/usr/bin/env ./node_modules/.bin/babel-node

/**
 * A simple wrapper script around `Transaction.validate` to validate a list of transactions.
 */

import '../../server/env';

import { Command } from 'commander';
import { uniq } from 'lodash';

import models, { Op } from '../../server/models';

const program = new Command()
  .description('Helper to validate transactions')
  .option('--data <dataKey>', 'Filter by data, ex: --data myFieldInData')
  .option('--group <transactionGroup>', 'Filter by transaction group')
  .option('--id <transactionIds>', 'Filter by transaction id')
  .parse();

const main = async () => {
  const options = program.opts();
  const where = {};
  if (options.data) {
    where['data'] = { [options.data]: { [Op.ne]: null } };
  } else if (options.group) {
    where['TransactionGroup'] = uniq(options.group.split(','));
  } else if (options.ids) {
    where['id'] = uniq(program.args[0].split(','));
  } else {
    throw new Error('Missing filtering option');
  }

  const transactions = await models.Transaction.findAll({ where });
  if (!transactions.length) {
    console.log('No transaction to validate');
    return;
  }

  for (const transaction of transactions) {
    try {
      await models.Transaction.validate(transaction);
    } catch (e) {
      console.error(`Transaction #${transaction.id} is invalid: ${e.message}`);
    }
  }

  console.log(`Done! Validated ${transactions.length} transactions`);
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
