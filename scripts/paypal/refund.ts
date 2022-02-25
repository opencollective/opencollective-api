#!/usr/bin/env ./node_modules/.bin/babel-node

import '../../server/env';

import { Command } from 'commander';

import logger from '../../server/lib/logger';
import { sleep } from '../../server/lib/utils';
import { findTransactionByPaypalId, refundPaypalCapture } from '../../server/paymentProviders/paypal/payment';

const main = async () => {
  const program = new Command();
  program.showSuggestionAfterError();

  const commaSeparatedArgs = list => list.split(',');

  // General options
  program.option('--captures <captureIds>', 'List of PayPal capture/transaction ids', commaSeparatedArgs);
  program.option('--reason <reason>', 'Why is this refunded? (sent to refundees)');

  // Parse arguments
  program.parse();
  const options = program.opts();
  const captureIds = options['captures'];
  if (!captureIds?.length) {
    program.help({ error: true });
  } else {
    for (const captureId of captureIds) {
      const ledgerTransaction = await findTransactionByPaypalId(captureId);
      if (!ledgerTransaction) {
        logger.warn(`No transaction found for PayPal capture ${captureId}`);
      } else {
        try {
          logger.info(`Refunding PayPal capture ${captureId} (order #${ledgerTransaction.OrderId})`);
          await refundPaypalCapture(ledgerTransaction, captureId, null, options['reason']);
        } catch (e) {
          logger.warn(`Could not refund PayPal transaction ${captureId}`, e);
        }
        sleep(1000); // To prevent rate-limiting issues with PayPal
      }
    }
  }
};

main()
  .then(() => process.exit())
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
