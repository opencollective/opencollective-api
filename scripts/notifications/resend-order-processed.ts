/**
 * A script to resend order.processed emails for contributions to specified tiers, with an erratum message.
 */

import '../../server/env';

import { Command } from 'commander';
import config from 'config';
import { difference, uniq } from 'lodash';
import { Op } from 'sequelize';

import { roles } from '../../server/constants';
import ActivityTypes from '../../server/constants/activities';
import { PAYMENT_METHOD_TYPE } from '../../server/constants/paymentMethods';
import { TransactionKind } from '../../server/constants/transaction-kind';
import { TransactionTypes } from '../../server/constants/transactions';
import emailLib from '../../server/lib/email';
import logger from '../../server/lib/logger';
import { notify } from '../../server/lib/notifications/email';
import { getTransactionPdf } from '../../server/lib/pdf';
import { toIsoDateStr } from '../../server/lib/utils';
import models from '../../server/models';

const main = async () => {
  const program = new Command();
  program.argument('<tierIds>', 'Comma-separated list of tier IDs');
  program.argument('<erratum>', 'Erratum message to include in the email');
  program.option('--execute', 'Actually send emails (default: dry run)');
  program.parse();

  const options = program.opts();
  const tierIdsStr = program.args[0];
  const erratum = program.args[1];
  const isDryRun = !options.execute;

  // Parse and validate tier IDs
  const tierIds = uniq(
    tierIdsStr.split(',').map(id => {
      const parsed = parseInt(id.trim());
      if (isNaN(parsed)) {
        throw new Error(`Invalid tier ID: ${id.trim()}`);
      }
      return parsed;
    }),
  );

  if (tierIds.length === 0) {
    throw new Error('No valid tier IDs provided');
  }

  console.log(`Processing ${tierIds.length} tier(s): ${tierIds.join(', ')}`);
  console.log(`Erratum message: ${erratum}`);
  console.log(`Mode: ${isDryRun ? 'DRY RUN' : 'EXECUTE'}`);

  // Verify tiers exist
  const tiers = await models.Tier.findAll({ where: { id: { [Op.in]: tierIds } } });
  if (tiers.length !== tierIds.length) {
    const returnedIds = tiers.map(t => t.id);
    const diff = difference(tierIds, returnedIds);
    throw new Error(`Some tiers were not found: ${diff.join(', ')}`);
  }

  // Query orders for these tiers
  const orders = await models.Order.findAll({
    where: { TierId: { [Op.in]: tierIds } },
    include: [
      { association: 'collective', required: true },
      { association: 'fromCollective', required: true },
      { association: 'Subscription' },
      { association: 'paymentMethod' },
    ],
  });

  console.log(`Found ${orders.length} order(s) for the specified tier(s)`);

  let processedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const order of orders) {
    try {
      // Find existing ORDER_PROCESSED activity for this order
      const activity = await models.Activity.findOne({
        where: {
          OrderId: order.id,
          type: ActivityTypes.ORDER_PROCESSED,
        },
        order: [['createdAt', 'DESC']], // Get the most recent one
      });

      if (!activity) {
        console.warn(`[SKIP] Order ${order.id}: No ORDER_PROCESSED activity found`);
        skippedCount++;
        continue;
      }

      // Get CONTRIBUTION CREDIT transactions (excluding refunds) for PDF generation
      const transactions = await models.Transaction.findAll({
        where: {
          OrderId: order.id,
          kind: TransactionKind.CONTRIBUTION,
          type: TransactionTypes.CREDIT,
          RefundTransactionId: null,
        },
        order: [['createdAt', 'ASC']],
      });

      const transaction = transactions.length > 0 ? transactions[0] : null;

      // Get user for PDF generation
      const user = await order.getUserForActivity();
      if (!user) {
        console.warn(`[SKIP] Order ${order.id}: No user found for fromCollective ${order.FromCollectiveId}`);
        skippedCount++;
        continue;
      }

      // Generate PDF attachments if applicable
      const attachments = [];
      if (transaction && order.paymentMethod?.type !== PAYMENT_METHOD_TYPE.GIFTCARD) {
        const transactionPdf = await getTransactionPdf(transaction, user);
        if (transactionPdf) {
          const createdAtString = toIsoDateStr(transaction.createdAt ? new Date(transaction.createdAt) : new Date());
          attachments.push({
            filename: `transaction_${order.collective.slug}_${createdAtString}_${transaction.uuid}.pdf`,
            content: transactionPdf,
          });
          (activity.data as any).transactionPdf = true;
        }

        if (transaction.hasPlatformTip()) {
          const platformTipTransaction = await transaction.getPlatformTipTransaction();
          if (platformTipTransaction) {
            const platformTipPdf = await getTransactionPdf(platformTipTransaction, user);
            if (platformTipPdf) {
              const createdAtString = toIsoDateStr(new Date(platformTipTransaction.createdAt));
              attachments.push({
                filename: `transaction_opencollective_${createdAtString}_${platformTipTransaction.uuid}.pdf`,
                content: platformTipPdf,
              });
              (activity.data as any).platformTipPdf = true;
            }
          }
        }
      }

      // Add erratum to activity data
      (activity.data as any).erratum = erratum;

      if (isDryRun) {
        const fromCollectiveId = activity.FromCollectiveId || activity.data?.fromCollective?.id;
        console.log(`[DRY RUN] Would send order.processed email for order ${order.id}`);
        console.log(`  - Activity ID: ${activity.id}`);
        console.log(`  - FromCollective ID: ${fromCollectiveId}`);
        console.log(`  - Collective: ${order.collective.name || order.collective.slug} (${order.CollectiveId})`);
        console.log(`  - Transaction: ${transaction ? transaction.id : 'none'}`);
        console.log(`  - Attachments: ${attachments.length}`);
        processedCount++;
      } else {
        console.log(`Sending order.processed email for order ${order.id}...`);
        await notify.collective(activity, {
          collectiveId: activity.FromCollectiveId || activity.data?.fromCollective?.id,
          role: [roles.ACCOUNTANT, roles.ADMIN],
          from: emailLib.generateFromEmailHeader(order.collective.name),
          attachments,
        });
        console.log(`✓ Sent email for order ${order.id}`);
        processedCount++;
      }
    } catch (error) {
      console.error(`[ERROR] Failed to process order ${order.id}:`, error.message);
      errorCount++;
      logger.error(`Failed to resend order.processed email for order ${order.id}`, error);
    }
  }

  console.log('\n=== Summary ===');
  console.log(`Processed: ${processedCount}`);
  console.log(`Skipped: ${skippedCount}`);
  console.log(`Errors: ${errorCount}`);
  console.log(`Total orders: ${orders.length}`);
};

if (require.main === module) {
  main()
    .then(() => {
      console.log('Done');
      process.exit(0);
    })
    .catch(e => {
      console.error('Error:', e);
      process.exit(1);
    });
}
