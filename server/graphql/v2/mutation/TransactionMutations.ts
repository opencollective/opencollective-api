import { GraphQLNonNull } from 'graphql';

import { Unauthorized } from '../../errors';
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
};

export default transactionMutations;
