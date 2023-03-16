#!/usr/bin/env ./node_modules/.bin/babel-node

/**
 * A script to cancel all subscriptions for a given collective.
 *
 * Before https://github.com/opencollective/opencollective-api/pull/8004, unhosted collectives
 * would not get their PayPal contributions cancelled. This script:
 * - Finds all active PayPal subscriptions for a given collective
 * - Cancels them
 * - Refunds the payments made since the unhosting date
 */

import '../../server/env';

import { Command } from 'commander';
import { flatten, get, uniq } from 'lodash';

import OrderStatuses from '../../server/constants/order_status';
import logger from '../../server/lib/logger';
import models, { Op, Subscription } from '../../server/models';
import { OrderModelInterface } from '../../server/models/Order';
import { paypalRequestV2 } from '../../server/paymentProviders/paypal/api';
import { getCaptureIdFromPaypalTransaction } from '../../server/paymentProviders/paypal/payment';
import {
  cancelPaypalSubscription,
  fetchPaypalSubscription,
  fetchPaypalTransactionsForSubscription,
} from '../../server/paymentProviders/paypal/subscription';

const getUnrecordedTransactions = async (host, order) => {
  const paypalSubscriptionId = order.Subscription.paypalSubscriptionId;
  const responseTransactions = await fetchPaypalTransactionsForSubscription(host, paypalSubscriptionId);
  const totalPages = responseTransactions.total_pages;
  if (totalPages > 1) {
    throw new Error('Pagination not supported yet');
  }

  // Reconcile transactions
  const dbTransactions = order.Transactions;
  const paypalTransactions = (responseTransactions['transactions'] as Record<string, unknown>[]) || [];
  const completedPayPalTransactions = paypalTransactions.filter(t => t['status'] === 'COMPLETED');
  if (dbTransactions.length !== completedPayPalTransactions.length) {
    console.log(
      `Order #${order.id} has ${dbTransactions.length} transactions in DB but ${completedPayPalTransactions.length} in PayPal`,
    );
  }

  const hasPayPalSaleId = id =>
    dbTransactions.find(dbTransaction => getCaptureIdFromPaypalTransaction(dbTransaction) === id);
  return completedPayPalTransactions.filter(paypalTransaction => !hasPayPalSaleId(paypalTransaction.id));
};

const main = async () => {
  const program = new Command();
  program.showSuggestionAfterError();
  program.arguments('<collectiveSlug>');
  program.option('--fix', 'Fix inconsistencies');
  program.parse();

  const [collectiveSlug] = program.args;
  const options = program.opts();
  const collective = await models.Collective.findBySlug(collectiveSlug);
  if (!collective) {
    throw new Error(`Collective ${collectiveSlug} not found`);
  }

  const orders = await models.Order.findAll<
    OrderModelInterface & { Transaction?: typeof models.Transaction; Subscription?: typeof Subscription }
  >({
    order: [['createdAt', 'DESC']],
    where: {
      CollectiveId: collective.id,
    },
    include: [
      {
        model: models.Subscription,
        where: {
          isActive: true,
          paypalSubscriptionId: { [Op.ne]: null },
        },
      },
      {
        model: models.Transaction,
        order: [['createdAt', 'DESC']],
        where: {
          kind: 'CONTRIBUTION',
          type: 'CREDIT',
          isRefund: false,
        },
      },
    ],
  });

  if (!orders.length) {
    console.log(`No active PayPal subscriptions found for collective ${collectiveSlug}`);
    return;
  }

  // Collective has changed host, so we must find the previous host
  const allTransactions = flatten(orders.map(o => o.Transactions));
  const allHostIds = uniq(allTransactions.map(t => t.HostCollectiveId));
  if (allHostIds.length !== 1) {
    throw new Error(`Collective ${collectiveSlug} has multiple hosts, or some transactions are missing`);
  }

  const host = await models.Collective.findByPk(allHostIds[0]);
  const notRecordedPaypalTransactions = <Record<string, unknown>[]>(
    flatten(await Promise.all(orders.map(order => getUnrecordedTransactions(host, order))))
  );

  // Fetch all transactions for active subscriptions
  console.log(`Found collective ${collectiveSlug} with id ${collective.id}`);
  console.log(`  - Current Host: #${collective.HostCollectiveId}`);
  console.log(`  - Previous Host: #${host.id}`);
  console.log(`  - Archived at: ${collective.deactivatedAt}`);
  console.log(`  - Active PayPal subscriptions: ${orders.length}`);
  console.log(`  - Unrecorded PayPal transactions (to refund): ${notRecordedPaypalTransactions.length}`);

  // Refund all transactions that are not recorded in the DB
  for (const paypalTransaction of notRecordedPaypalTransactions) {
    const amount = get(paypalTransaction, 'amount_with_breakdown.gross_amount');
    const amountStr = amount ? `${amount['currency_code']} ${amount['value']}` : '~';
    console.log(
      `    -> [${paypalTransaction.time}] PayPal transaction ${paypalTransaction.id} for ${amountStr} needs to be refunded`,
    );

    if (options['fix']) {
      const captureId = paypalTransaction['id'];
      try {
        const result = await paypalRequestV2(`payments/captures/${captureId}/refund`, host, 'POST', {
          // eslint-disable-next-line camelcase
          note_to_payer: `${collective.name} (https://opencollective.com/${collective.slug}) has been archived`,
        });

        if (result.status === 'COMPLETED') {
          logger.info(`Refunded PayPal capture ${captureId}`);
        } else {
          logger.warn(result);
        }
      } catch (e) {
        // Ignore errors, they'll be logged by the paypalRequestV2 function
        continue;
      }
    }
  }

  // Cancel the order / subscription
  for (const order of orders) {
    const paypalSubscriptionId = order.Subscription.paypalSubscriptionId;
    const subscription = await fetchPaypalSubscription(host, paypalSubscriptionId);

    // Cancel on PayPal
    if (subscription.status === 'ACTIVE') {
      const cancelReason = `Collective ${collective.name} (https://opencollective.com/${collective.slug}) has been archived`;
      console.log(`  - Need to cancel PayPal subscription ${paypalSubscriptionId}: ${cancelReason}`);
      if (options['fix']) {
        await cancelPaypalSubscription(order, cancelReason, host);
        console.log(`  - PayPal subscription ${paypalSubscriptionId} cancelled`);
      }
    } else {
      console.log(`  - PayPal subscription ${paypalSubscriptionId} is already cancelled`);
    }

    // Cancel in DB
    if (options['fix']) {
      await order.update({ status: OrderStatuses.CANCELLED });
      await order.Subscription.update({ isActive: false, deactivatedAt: new Date() });
    }
  }
};

main()
  .then(() => process.exit())
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
