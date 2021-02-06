import { GraphQLNonNull, GraphQLString } from 'graphql';

import orderStatus from '../../../constants/order_status';
import { canReject } from '../../../graphql/common/transactions';
import { purgeCacheForCollective } from '../../../lib/cache';
import { notifyAdminsOfCollective } from '../../../lib/notifications';
import models from '../../../models';
import { Forbidden, NotFound, Unauthorized } from '../../errors';
import { refundTransaction as legacyRefundTransaction } from '../../v1/mutations/orders';
import { fetchTransactionWithReference, TransactionReferenceInput } from '../input/TransactionReferenceInput';
import { Transaction } from '../interface/Transaction';

const transactionMutations = {
  refundTransaction: {
    type: new GraphQLNonNull(Transaction),
    description: 'Refunds transaction',
    args: {
      transaction: {
        type: new GraphQLNonNull(TransactionReferenceInput),
        description: 'Reference of the transaction to refund',
      },
    },
    async resolve(_, args, req): Promise<typeof Transaction> {
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
    async resolve(_, args, req): Promise<typeof Transaction> {
      if (!req.remoteUser) {
        throw new Unauthorized();
      }

      // get transaction info
      const transaction = await fetchTransactionWithReference(args.transaction);

      const canUserReject = await canReject(transaction, undefined, req);
      if (!canUserReject) {
        throw new Forbidden('Cannot reject this transaction');
      }

      /** refund transaction and set status - - if the transaction has already been
       * refunded we don't want to try and do it again, but we will continue with
       * marking the order as 'REJECTED'
       */
      let refundedTransaction;
      if (!transaction.RefundTransactionId) {
        refundedTransaction = await legacyRefundTransaction(undefined, { id: transaction.id }, req);
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
        await orderToUpdate.Subscription.deactivate();
      } else {
        // else just update the status to REJECTED
        await orderToUpdate.update({
          status: orderStatus.REJECTED,
        });
      }

      // get membership info & remove member from Collective
      const toAccount = await models.Collective.findByPk(transaction.CollectiveId);
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
      const rejectionReason =
        args.message ||
        `An administrator of ${collective.name} manually rejected your contribution without providing a specific message.`;

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
