#!/usr/bin/env ./node_modules/.bin/babel-node
import '../../server/env.js';

import { Command } from 'commander';
import { toNumber } from 'lodash-es';

import { findPaymentMethodProvider, refundTransaction } from '../../server/lib/payments.js';
import models from '../../server/models/index.js';
import { PaymentProviderService } from '../../server/paymentProviders/types.js';

const DRY_RUN = process.env.DRY_RUN !== 'false';

/** Parse command-line arguments */
const getProgram = argv => {
  const program = new Command();
  program.argument('<transactionId>', 'Transaction ID to refund');
  program.option('--onlyInDatabase', 'Only refund the transaction in the database, do not call the payment provider');
  program.option('--as <userSlug>', 'User triggering the refund');
  program.option('-r --reason <reason>', 'Reason for the refund', 'Refund transaction');
  program.parse(argv);
  return program;
};

const main = async () => {
  const program = getProgram(process.argv);
  const transactionId = toNumber(program.args[0]);
  const options = program.opts();
  let user = null;

  // Load data
  const transaction = await models.Transaction.findByPk(transactionId, {
    include: [{ model: models.PaymentMethod, as: 'PaymentMethod' }],
  });
  if (!transaction) {
    throw new Error(`Could not find transaction #${transactionId}`);
  }

  if (options.as) {
    const collective = await models.Collective.findBySlug(options.as);
    user = await collective?.getUser();
    user.collective = collective;
  }

  // Trigger refund
  if (DRY_RUN) {
    console.log(
      `[Dry mode] Would have refunded transaction #${transactionId} as ${
        user?.collective?.slug || '*anonymous*'
      } with reason "${options.reason}"`,
    );
  } else {
    if (!options.onlyInDatabase) {
      await refundTransaction(transaction, user, options.reason);
    } else {
      const paymentProvider: PaymentProviderService = findPaymentMethodProvider(transaction.PaymentMethod);
      if (!paymentProvider.refundTransactionOnlyInDatabase) {
        throw new Error(`Payment method does not support refundTransactionOnlyInDatabase`);
      }

      await paymentProvider.refundTransactionOnlyInDatabase(transaction, user, options.reason);
    }
  }
};

main()
  .then(() => process.exit())
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
