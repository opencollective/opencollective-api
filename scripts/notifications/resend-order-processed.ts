/**
 * A script to resend order.processed emails for contributions to specified tiers, with an erratum message.
 */

import '../../server/env';

import { Command } from 'commander';
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
import models, { Order } from '../../server/models';

export const main = async () => {
  const program = new Command();
  program.argument('<erratum>', 'Erratum message to include in the email');
  program.option('--tierIds <tierIds>', 'Comma-separated list of tier IDs');
  program.option('--orderIds <orderIds>', 'Comma-separated list of order IDs');
  program.option('--execute', 'Actually send emails (default: dry run)');
  program.option('--includeTicketConfirmed', 'Include ticket.confirmed activities');
  program.parse();

  const options = program.opts();
  const tierIdsStr = options.tierIds;
  const orderIdsStr = options.orderIds;
  const erratum = program.args[0];
  const isDryRun = !options.execute;
  const includeTicketConfirmed = options.includeTicketConfirmed;

  if (!erratum) {
    throw new Error('Erratum message is required');
  }

  // Parse and validate tier IDs
  const getNumId = (id: string): number => {
    const parsed = parseInt(id.trim());
    if (isNaN(parsed)) {
      throw new Error(`Invalid ID: ${id.trim()}`);
    }
    return parsed;
  };

  const tierIds = uniq<number>(tierIdsStr?.split(',').map(getNumId));
  const orderIds = uniq<number>(orderIdsStr?.split(',').map(getNumId));
  if (tierIds.length === 0 && orderIds.length === 0) {
    throw new Error('No valid tier or order IDs provided');
  } else if (tierIds.length > 0 && orderIds.length > 0) {
    throw new Error('Cannot provide both tier and order IDs');
  }

  const ordersInclude = [
    { association: 'collective', required: true },
    { association: 'fromCollective', required: true },
  ];

  let orders: Order[] = [];
  if (tierIds.length > 0) {
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
    orders = await models.Order.findAll({
      where: { TierId: { [Op.in]: tierIds } },
      include: ordersInclude,
    });
  } else if (orderIds.length > 0) {
    console.log(`Processing ${orderIds.length} order(s): ${orderIds.join(', ')}`);
    console.log(`Erratum message: ${erratum}`);
    console.log(`Mode: ${isDryRun ? 'DRY RUN' : 'EXECUTE'}`);

    // Verify orders exist
    orders = await models.Order.findAll({ where: { id: { [Op.in]: orderIds } }, include: ordersInclude });
    if (orders.length !== orderIds.length) {
      const returnedIds = orders.map(o => o.id);
      const diff = difference(orderIds, returnedIds);
      throw new Error(`Some orders were not found: ${diff.join(', ')}`);
    }
  }

  console.log(`Found ${orders.length} order(s) to process`);

  let processedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const order of orders) {
    try {
      // Find existing ORDER_PROCESSED activities for this order
      const activities = await models.Activity.findAll({
        where: {
          OrderId: order.id,
          type: [ActivityTypes.ORDER_PROCESSED, includeTicketConfirmed ? ActivityTypes.TICKET_CONFIRMED : null].filter(
            Boolean,
          ),
        },
        order: [['createdAt', 'DESC']], // Get the most recent one
      });

      if (!activities.length) {
        console.warn(`[SKIP] Order ${order.id}: No ORDER_PROCESSED or TICKET_CONFIRMED activity found`);
        skippedCount++;
        continue;
      }

      // Get user for PDF generation
      const user = await order.getUserForActivity();
      if (!user) {
        console.warn(`[SKIP] Order ${order.id}: No user found for fromCollective ${order.FromCollectiveId}`);
        skippedCount++;
        continue;
      }

      for (const activity of activities) {
        // Get the corresponding transaction (the activity is always created after the transaction)
        const transaction = await models.Transaction.findOne({
          order: [['createdAt', 'DESC']],
          include: [{ model: models.PaymentMethod, required: false }],
          where: {
            OrderId: order.id,
            type: TransactionTypes.CREDIT,
            kind: TransactionKind.CONTRIBUTION,
            RefundTransactionId: null,
            createdAt: { [Op.lte]: activity.createdAt },
          },
        });

        // Check if transaction is valid
        if (!transaction) {
          console.warn(`[SKIP] Order ${order.id}: No valid transaction found`);
          skippedCount++;
          continue;
        }

        // Generate PDF attachments if applicable
        const attachments = [];
        if (!isDryRun && transaction.PaymentMethod?.type !== PAYMENT_METHOD_TYPE.GIFTCARD) {
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

        // No need to send email if no attachments
        if (!isDryRun && !attachments.length) {
          console.warn(`[SKIP] Order ${order.id}: No attachments found`);
          skippedCount++;
          continue;
        }

        // Add erratum to activity data
        activity.data.erratum = erratum;

        if (isDryRun) {
          const fromCollectiveId = activity.FromCollectiveId || activity.data.fromCollective?.id;
          console.log(`[DRY RUN] Would send order.processed email for order ${order.id}`);
          console.log(`  - Activity: #${activity.id} (${activity.createdAt})`);
          console.log(`  - Transaction: #${transaction.id} (${transaction.createdAt})`);
          console.log(`  - Collective: ${order.collective.name || order.collective.slug} (${order.CollectiveId})`);
          console.log(`  - FromCollective ID: ${fromCollectiveId}, Tier Id: ${order.TierId}`);
          console.log(`  - Attachments: ${attachments.length}`);
          processedCount++;
        } else {
          console.log(`Sending order.processed email for order ${order.id}...`);
          await notify.collective(activity, {
            collectiveId: activity.FromCollectiveId || activity.data.fromCollective?.id,
            role: [roles.ACCOUNTANT, roles.ADMIN],
            from: emailLib.generateFromEmailHeader(order.collective.name),
            attachments,
          });
          console.log(`✓ Sent email for order ${order.id}`);
          processedCount++;
        }
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
