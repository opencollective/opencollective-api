import { GraphQLString } from 'graphql';

import models from '../../../models';
import { NotFound } from '../../errors';
import { fetchTransactionWithReference, GraphQLTransactionReferenceInput } from '../input/TransactionReferenceInput';
import { GraphQLTransaction } from '../interface/Transaction';

const TransactionQuery = {
  type: GraphQLTransaction,
  description: 'Fetch a single transaction',
  args: {
    id: {
      type: GraphQLString,
      description: 'The public id identifying the transaction (ie: rvelja97-pkzqbgq7-bbzyx6wd-50o8n4rm)',
      deprecationReason: '2024-05-07: Please use the `transaction` field.',
    },
    transaction: {
      type: GraphQLTransactionReferenceInput,
      description: 'Identifiers to retrieve the transaction.',
    },
  },
  async resolve(_, args, req) {
    let transaction;
    if (args.transaction) {
      transaction = await fetchTransactionWithReference(args.transaction, req);
    } else if (args.id) {
      transaction = await models.Transaction.findOne({ where: { uuid: args.id } });
    } else {
      return new Error('Please provide an id');
    }
    if (!transaction) {
      throw new NotFound('Transaction Not Found');
    }
    return transaction;
  },
};

export default TransactionQuery;
