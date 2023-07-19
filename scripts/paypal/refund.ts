#!/usr/bin/env ./node_modules/.bin/ts-node

import '../../server/env.js';

import { Command } from 'commander';
import { truncate } from 'lodash-es';

import logger from '../../server/lib/logger.js';
import { sleep } from '../../server/lib/utils.js';
import models from '../../server/models/index.js';
import { paypalRequestV2 } from '../../server/paymentProviders/paypal/api.js';
import { findTransactionByPaypalId, refundPaypalCapture } from '../../server/paymentProviders/paypal/payment.js';

const main = async () => {
  const program = new Command();
  program.showSuggestionAfterError();

  const commaSeparatedArgs = list => list.split(',');

  // General options
  program.option('--captures <captureIds>', 'List of PayPal capture/transaction ids', commaSeparatedArgs);
  program.option('--reason <reason>', 'Why is this refunded? (sent to refundees)');
  program.option('--run', 'Actually run the script');
  program.option('--host <hostSlug>', 'Host that holds the transaction (to speed up the search)');
  program.option('--paypalOnly', 'Do not look for the transaction in DB, only refund PayPal');

  // Parse arguments
  program.parse();
  const options = program.opts();
  const captureIds = options['captures'];
  const host = options['host'] && (await models.Collective.findBySlug(options['host']));
  if (!captureIds?.length) {
    program.help({ error: true });
  } else if (!options['reason']) {
    throw new Error('You must provide a reason for the refund');
  } else {
    for (const captureId of captureIds) {
      let ledgerTransaction;
      if (!options['paypalOnly']) {
        ledgerTransaction = await findTransactionByPaypalId(captureId, { HostCollectiveId: host?.id });

        if (!ledgerTransaction) {
          throw new Error(`No transaction found for PayPal capture ${captureId}`);
        }
      }

      try {
        if (options['run']) {
          if (options['paypalOnly']) {
            // eslint-disable-next-line camelcase
            const payload = { note_to_payer: truncate(options['reason'], { length: 255 }) || undefined };
            const result = await paypalRequestV2(`payments/captures/${captureId}/refund`, host, 'POST', payload);
            if (result.status === 'COMPLETED') {
              logger.info(`Refunded PayPal capture ${captureId}`);
            } else {
              logger.warn(result);
            }
          } else {
            logger.info(
              `Refunding PayPal capture in ledger + PayPal ${captureId} (order #${ledgerTransaction.OrderId})`,
            );
            await refundPaypalCapture(ledgerTransaction, captureId, null, options['reason']);
          }
        } else {
          logger.info(`Would refund PayPal capture ${captureId} (order #${ledgerTransaction?.OrderId || 'N/A'})`);
        }
      } catch (e) {
        logger.warn(`Could not refund PayPal transaction ${captureId}`, e);
      }
      sleep(3000); // To prevent rate-limiting issues with PayPal
    }
  }
};

main()
  .then(() => process.exit())
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
