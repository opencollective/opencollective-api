import models from '../../../../models';

import { CollectionArgs } from '../../interface/Collection';
import { TransactionCollection } from '../../collection/TransactionCollection';
import { TransactionType } from '../../enum/TransactionType';
import { ChronologicalOrderInput } from '../../input/ChronologicalOrderInput';

const TransactionsQuery = {
  type: TransactionCollection,
  args: {
    ...CollectionArgs,
    type: {
      type: TransactionType,
      description: 'The transaction type (DEBIT or CREDIT)',
    },
    orderBy: {
      type: ChronologicalOrderInput,
      description: 'The order of results',
      defaultValue: ChronologicalOrderInput.defaultValue,
    },
  },
  async resolve(_, args) {
    const where = {};

    if (args.type) {
      where.type = args.type;
    }

    const result = await models.Transaction.findAndCountAll({
      where,
      limit: args.limit,
      offset: args.offset,
      order: [[args.orderBy.field, args.orderBy.direction]],
    });

    return { nodes: result.rows, totalCount: result.count, limit: args.limit, offset: args.offset };
  },
};

export default TransactionsQuery;
