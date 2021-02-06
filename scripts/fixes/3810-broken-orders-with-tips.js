/**
 * Recreates transactions for successfull order based on the existing tip transactions.
 * After that, remove broken tip transactions.
 *
 * Issue: https://github.com/opencollective/opencollective/issues/3810
 */

import { omit } from 'lodash';

import * as constants from '../../server/constants/transactions';
import { getHostFee, getPlatformFee } from '../../server/lib/payments';
import { extractFees } from '../../server/lib/stripe';
import models, { sequelize } from '../../server/models';

const isDry = process.env.DRY;
const affectedOrderIds = [
  115250,
  115238,
  115105,
  115104,
  115065,
  115064,
  115047,
  115045,
  115044,
  115021,
  115000,
  114969,
  114952,
  114751,
  114750,
  111824,
  111822,
  110638,
  110640,
];

(async function () {
  for (const OrderId of affectedOrderIds) {
    try {
      console.log(`Fixing Order #${OrderId}...`);
      const order = await models.Order.findByPk(OrderId);

      if (!order) {
        throw `Couldn't find Order ${OrderId}`;
      }

      if (!order.data.error) {
        console.log(`Order #${OrderId} already fixed, skipping`);
        continue;
      }

      await order.populate();
      const tipCreditTransaction = await models.Transaction.findOne({
        where: {
          OrderId,
          type: 'CREDIT',
        },
      });
      const { charge, balanceTransaction } = tipCreditTransaction.data;

      const host = await order.collective.getHostCollective();
      const hostPlan = await host.getPlan();
      const isSharedRevenue = !!hostPlan.hostFeeSharePercent;

      // Read or compute Platform Fee
      const platformFee = await getPlatformFee(order.totalAmount, order, host, { hostPlan });
      const platformTip = order.data?.platformFee;

      const fees = extractFees(balanceTransaction);
      const hostFeeInHostCurrency = await getHostFee(balanceTransaction.amount, order);
      const data = {
        charge,
        balanceTransaction,
        isFeesOnTop: order.data?.isFeesOnTop,
        isSharedRevenue,
        settled: true,
        platformFee: platformFee,
        platformTip,
      };

      let platformFeeInHostCurrency = fees.applicationFee;
      if (isSharedRevenue) {
        // Platform Fee In Host Currency makes no sense in the shared revenue model.
        platformFeeInHostCurrency = platformTip || 0;
        data.hostFeeSharePercent = hostPlan.hostFeeSharePercent;
      }

      const payload = {
        CreatedByUserId: order.CreatedByUserId,
        FromCollectiveId: order.FromCollectiveId,
        CollectiveId: order.CollectiveId,
        PaymentMethodId: order.PaymentMethodId,
        transaction: {
          type: constants.TransactionTypes.CREDIT,
          OrderId: order.id,
          amount: order.totalAmount,
          currency: order.currency,
          hostCurrency: balanceTransaction.currency,
          amountInHostCurrency: balanceTransaction.amount,
          hostCurrencyFxRate: balanceTransaction.amount / order.totalAmount,
          paymentProcessorFeeInHostCurrency: fees.stripeFee,
          taxAmount: order.taxAmount,
          description: order.description,
          hostFeeInHostCurrency,
          platformFeeInHostCurrency,
          data,
        },
      };

      // Recreate all transactions
      if (!isDry) {
        await models.Transaction.createFromPayload(payload);

        // Deleted past platform tip transactions
        const deletedTransactions = await models.Transaction.destroy({
          where: { TransactionGroup: tipCreditTransaction.TransactionGroup },
        });

        // Update order to remove error from data and mark it as paid
        await order.update({ data: omit(order.data, ['error']), status: 'PAID' });
        console.log(`Done. Recreated transactions and deleted previously ${deletedTransactions} created transactions.`);
      }

      console.log('Done.\n');
    } catch (e) {
      console.error(e);
    }
  }

  sequelize.close();
})();
