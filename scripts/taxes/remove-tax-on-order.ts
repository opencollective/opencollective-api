#!/usr/bin/env ./node_modules/.bin/babel-node

import '../../server/env';

import assert from 'assert';

import { Command } from 'commander';

import logger from '../../server/lib/logger';
import models, { sequelize } from '../../server/models';

const program = new Command()
  .description('Helper to remove a tax on an existing order and all its transactions')
  .arguments('OrderId')
  .option('--run', 'Trigger changes')
  .parse();

const main = async () => {
  const orderId = program.args[0];
  const options = program.opts();

  if (!options['run']) {
    logger.info('This is a dry run, use --run to trigger changes');
  }

  // Load order
  const order = await models.Order.findByPk(orderId, { include: [{ association: 'Transactions' }] });
  assert(order, `Order ${orderId} not found`);
  assert(order.data?.tax, `Order ${orderId} doesn't have taxes`);
  assert(
    order.Transactions.every(t => !t.isRefund),
    `Order ${orderId} has refunds, not supported yet`,
  );

  await sequelize.transaction(async dbTransaction => {
    // Update order
    logger.info(`Removing tax ${order.data.tax.id} from order ${orderId}`);
    await order.update(
      {
        taxAmount: null,
        data: {
          ...order.data,
          taxRemovedFromMigration: order.data.tax,
          taxAmountRemovedFromMigration: order.taxAmount,
          tax: null,
        },
      },
      { transaction: dbTransaction },
    );

    // Update transactions
    if (order.Transactions.length) {
      for (const transaction of order.Transactions) {
        // If already removed, or not affected (e.g. HOST_FEE, PLATFORM_TIP don't have taxAmount recorded)
        if (!transaction.taxAmount) {
          continue;
        }

        logger.info(`Removing tax ${transaction.data.tax['id']} from transaction ${transaction.id}`);
        const taxAmount = transaction.taxAmount;
        const taxAmountInHostCurrency = Math.round(transaction.taxAmount * transaction.hostCurrencyFxRate);
        if (transaction.type === 'CREDIT') {
          transaction.netAmountInCollectiveCurrency = transaction.netAmountInCollectiveCurrency - taxAmount;
        } else {
          transaction.amount = transaction.amount + transaction.taxAmount; // Tax amount is expressed in transaction currency
          transaction.amountInHostCurrency = transaction.amountInHostCurrency + taxAmountInHostCurrency;
        }

        transaction.taxAmount = null;
        transaction.data = {
          ...transaction.data,
          taxRemovedFromMigration: transaction.data.tax,
          taxAmountRemovedFromMigration: transaction.taxAmount,
          tax: null,
        };

        await models.Transaction.validate(transaction, { validateOppositeTransaction: false });
        await transaction.save({ transaction: dbTransaction });
      }
    }

    if (!options['run']) {
      throw new Error('Dry run, aborting');
    }
  });

  logger.info('Done!');
};

main()
  .then(() => {
    process.exit(0);
  })
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
