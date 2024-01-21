import express from 'express';
import { GraphQLNonNull, GraphQLString } from 'graphql';

import { activities } from '../../../constants';
import orderStatus from '../../../constants/order-status';
import { purgeCacheForCollective } from '../../../lib/cache';
import twoFactorAuthLib from '../../../lib/two-factor-authentication';
import models from '../../../models';
import { TransactionInterface } from '../../../models/Transaction';
import { checkRemoteUserCanUseTransactions } from '../../common/scope-check';
import { canReject, refundTransaction } from '../../common/transactions';
import { Forbidden, NotFound } from '../../errors';
import { fetchTransactionWithReference, GraphQLTransactionReferenceInput } from '../input/TransactionReferenceInput';
import { GraphQLTransaction } from '../interface/Transaction';

const transactionMutations = {
  refundTransaction: {
    type: GraphQLTransaction,
    description: 'Refunds a transaction. Scope: "transactions".',
    args: {
      transaction: {
        type: new GraphQLNonNull(GraphQLTransactionReferenceInput),
        description: 'Reference of the transaction to refund',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<typeof GraphQLTransaction> {
      checkRemoteUserCanUseTransactions(req);
      const transaction = await fetchTransactionWithReference(args.transaction, { throwIfMissing: true });
      return refundTransaction(transaction, req);
    },
  },
  rejectTransaction: {
    type: new GraphQLNonNull(GraphQLTransaction),
    description:
      'Rejects transaction, removes member from Collective, and sends a message to the contributor. Scope: "transactions".',
    args: {
      transaction: {
        type: new GraphQLNonNull(GraphQLTransactionReferenceInput),
        description: 'Reference of the transaction to refund',
      },
      message: {
        type: GraphQLString,
        description: 'Message to send to the contributor whose contribution has been rejected',
      },
    },
    async resolve(_: void, args, req: express.Request): Promise<TransactionInterface> {
      checkRemoteUserCanUseTransactions(req);

      // get transaction info
      const transaction = await fetchTransactionWithReference(args.transaction);

      const canUserReject = await canReject(transaction, undefined, req);
      if (!canUserReject) {
        throw new Forbidden('Cannot reject this transaction');
      }

      const toAccount = await req.loaders.Collective.byId.load(transaction.CollectiveId);
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
        refundedTransaction = await refundTransaction(transaction, req, refundParams);
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

      if (req.remoteUser.isAdminOfCollective(toAccount)) {
        await twoFactorAuthLib.enforceForAccount(req, toAccount, { onlyAskOnLogin: true });
      } else if (req.remoteUser.isAdmin(transaction.HostCollectiveId)) {
        const host = await req.loaders.Collective.byId.load(transaction.HostCollectiveId);
        await twoFactorAuthLib.enforceForAccount(req, host, { onlyAskOnLogin: true });
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
      const fromAccount = await req.loaders.Collective.byId.load(transaction.FromCollectiveId);
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
      const activity = {
        type: activities.CONTRIBUTION_REJECTED,
        OrderId: orderToUpdate.id,
        FromCollectiveId: orderToUpdate.FromCollectiveId,
        CollectiveId: orderToUpdate.CollectiveId,
        HostCollectiveId: toAccount.approvedAt ? toAccount.HostCollectiveId : null,
        data: {
          rejectionReason,
          collective: toAccount.info,
          fromCollective: fromAccount.info,
        },
      };
      await models.Activity.create(activity);

      return transaction;
    },
  },
};

export default transactionMutations;
