import { GraphQLString } from 'graphql';

import models from '../../../models';
import { NotFound } from '../../errors';
import { idDecode } from '../identifiers';
import { Transaction } from '../interface/Transaction';

const TransactionQuery = {
  type: Transaction,
  args: {
    id: {
      type: GraphQLString,
      description: 'The public id identifying the transaction (ie: rvelja97-pkzqbgq7-bbzyx6wd-50o8n4rm)',
    },
  },
  async resolve(_, args) {
    let transaction;
    if (args.id) {
      const id = idDecode(args.id, 'transaction');
      transaction = await models.Transaction.findByPk(id);
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
