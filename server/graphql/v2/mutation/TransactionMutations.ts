import express from 'express';
import { GraphQLNonNull, GraphQLString } from 'graphql';

import orderStatus from '../../../constants/order_status';
import { TransactionKind } from '../../../constants/transaction-kind';
import { purgeCacheForCollective } from '../../../lib/cache';
import { notifyAdminsOfCollective } from '../../../lib/notifications';
import models from '../../../models';
import { canReject } from '../../common/transactions';
import { Forbidden, NotFound, Unauthorized, ValidationFailed } from '../../errors';
import { refundTransaction as legacyRefundTransaction } from '../../v1/mutations/orders';
import { AmountInput, getValueInCentsFromAmountInput } from '../input/AmountInput';
import { fetchTransactionWithReference, TransactionReferenceInput } from '../input/TransactionReferenceInput';
import { Transaction } from '../interface/Transaction';

const transactionMutations = {
  addPlatformTipToTransaction: {
    type: new GraphQLNonNull(Transaction),
    description: 'Add platform tips to a transaction',
    args: {
      transaction: {
        type: new GraphQLNonNull(TransactionReferenceInput),
        description: 'Reference to the transaction in the platform tip',
      },
      amount: {
        type: new GraphQLNonNull(AmountInput),
        description: 'Amount of the platform tip',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<typeof Transaction> {
      if (!req.remoteUser) {
        throw new Unauthorized('You need to be logged in to add a platform tip');
      }

      const transaction = await fetchTransactionWithReference(args.transaction, { throwIfMissing: true });

      if (!req.remoteUser.isAdmin(transaction.HostCollectiveId)) {
        throw new Unauthorized('Only host admins can add platform tips');
      } else if (transaction.kind !== TransactionKind.ADDED_FUNDS) {
        throw new ValidationFailed('Platform tips can only be added on added funds');
      }

      const existingPlatformTip = await transaction.getPlatformTipTransaction();
      if (existingPlatformTip) {
        throw new Error('Platform tip is already set for this transaction group');
      }

      const expectedCurrency = transaction.currency;
      const platformTipInCents = getValueInCentsFromAmountInput(args.amount, { expectedCurrency });
      if (!platformTipInCents) {
        throw new ValidationFailed('Platform tip amount must be greater than 0');
      }

      // We fake a transactionData object to pass to createPlatformTipTransactions
      // It's not ideal but it's how it is
      const transactionData = {
        ...transaction.dataValues,
        CreatedByUserId: req.remoteUser.id,
        FromCollectiveId: transaction.HostCollectiveId,
        data: {
          ...transaction.dataValues.data,
          isFeesOnTop: true,
          hasPlatformTip: true,
          platformTip: platformTipInCents,
        },
      };

      const host = await models.Collective.findByPk(transaction.HostCollectiveId);

      const { platformTipTransaction } = await models.Transaction.createPlatformTipTransactions(transactionData, host);

      return platformTipTransaction;
    },
  },
  refundTransaction: {
    type: Transaction,
    description: 'Refunds transaction',
    args: {
      transaction: {
        type: new GraphQLNonNull(TransactionReferenceInput),
        description: 'Reference of the transaction to refund',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<typeof Transaction> {
      if (!req.remoteUser) {
        throw new Unauthorized();
      }
      const transaction = await fetchTransactionWithReference(args.transaction);
      return legacyRefundTransaction(undefined, { id: transaction.id }, req);
    },
  },
  rejectTransaction: {
    type: new GraphQLNonNull(Transaction),
    description: 'Rejects transaction, removes member from Collective, and sends a message to the contributor',
    args: {
      transaction: {
        type: new GraphQLNonNull(TransactionReferenceInput),
        description: 'Reference of the transaction to refund',
      },
      message: {
        type: GraphQLString,
        description: 'Message to send to the contributor whose contribution has been rejected',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<typeof Transaction> {
      if (!req.remoteUser) {
        throw new Unauthorized();
      }

      // get transaction info
      const transaction = await fetchTransactionWithReference(args.transaction);

      const canUserReject = await canReject(transaction, undefined, req);
      if (!canUserReject) {
        throw new Forbidden('Cannot reject this transaction');
      }

      const toAccount = await models.Collective.findByPk(transaction.CollectiveId);
      const rejectionReason =
        args.message ||
        `An administrator of ${toAccount.name} manually rejected your contribution without providing a specific reason.`;

      /** refund transaction and set status - - if the transaction has already been
       * refunded we don't want to try and do it again, but we will continue with
       * marking the order as 'REJECTED'
       */
      let refundedTransaction;
      if (!transaction.RefundTransactionId) {
        const refundParams = { id: transaction.id, message: rejectionReason };
        refundedTransaction = await legacyRefundTransaction(undefined, refundParams, req);
      } else {
        refundedTransaction = await fetchTransactionWithReference({ legacyId: transaction.RefundTransactionId });
      }

      if (!refundedTransaction) {
        throw new NotFound('Refunded transaction not found');
      }

      const orderToUpdate = await models.Order.findOne({
        where: { id: refundedTransaction.OrderId },
        include: { model: models.Subscription },
      });

      if (!orderToUpdate) {
        throw new NotFound('Order not found');
      }

      if (orderToUpdate.SubscriptionId) {
        await orderToUpdate.update({ status: orderStatus.REJECTED });
        await orderToUpdate.Subscription.deactivate('Contribution rejected');
      } else {
        // else just update the status to REJECTED
        await orderToUpdate.update({
          status: orderStatus.REJECTED,
        });
      }

      // get membership info & remove member from Collective
      const fromAccount = await models.Collective.findByPk(transaction.FromCollectiveId);
      await models.Member.destroy({
        where: {
          MemberCollectiveId: fromAccount.id,
          CollectiveId: toAccount.id,
          role: 'BACKER',
        },
      });
      purgeCacheForCollective(fromAccount.slug);
      purgeCacheForCollective(toAccount.slug);

      // email contributor(s) to let them know their transaction has been rejected
      const collective = {
        name: toAccount.name,
      };

      const data = { collective, rejectionReason };

      const activity = {
        type: 'contribution.rejected',
        data,
      };

      await notifyAdminsOfCollective(fromAccount.id, activity);

      return transaction;
    },
  },
};

export default transactionMutations;
