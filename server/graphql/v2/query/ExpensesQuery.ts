import { GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';

import models, { Op } from '../../../models';
import { ExpenseCollection } from '../collection/ExpenseCollection';
import ExpenseStatus from '../enum/ExpenseStatus';
import { ExpenseType } from '../enum/ExpenseType';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE, ChronologicalOrderInput } from '../input/ChronologicalOrderInput';
import { CollectionArgs, CollectionReturnType } from '../interface/Collection';

const ExpensesQuery = {
  type: ExpenseCollection,
  args: {
    ...CollectionArgs,
    fromAccount: {
      type: AccountReferenceInput,
      description: 'Reference of the account that submitted this expense',
    },
    account: {
      type: AccountReferenceInput,
      description: 'Reference of the account where this expense was submitted',
    },
    status: {
      type: ExpenseStatus,
      description: 'Use this field to filter expenses on their statuses',
    },
    type: {
      type: ExpenseType,
      description: 'Use this field to filter expenses on their type (RECEIPT/INVOICE)',
    },
    tags: {
      type: new GraphQLList(GraphQLString),
      description: 'Only expenses that match these tags',
    },
    orderBy: {
      type: new GraphQLNonNull(ChronologicalOrderInput),
      description: 'The order of results',
      defaultValue: CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE,
    },
  },
  async resolve(_, args, req): Promise<CollectionReturnType> {
    const where = {};
    const fetchAccountParams = { loaders: req.loaders, throwIfMissing: true };

    // Load accounts
    if (args.fromAccount) {
      const fromAccount = await fetchAccountWithReference(args.fromAccount, fetchAccountParams);
      where['FromCollectiveId'] = fromAccount.id;
    }
    if (args.account) {
      const collective = await fetchAccountWithReference(args.account, fetchAccountParams);
      where['CollectiveId'] = collective.id;
    }

    // Add filters
    if (args.status) {
      where['status'] = args.status;
    }
    if (args.type) {
      where['type'] = args.type;
    }
    if (args.tags) {
      where['tags'] = { [Op.contains]: args.tags };
    }

    const order = [[args.orderBy.field, args.orderBy.direction]];
    const { offset, limit } = args;
    const result = await models.Expense.findAndCountAll({ where, order, offset, limit });
    return {
      nodes: result.rows,
      totalCount: result.count,
      limit: args.limit,
      offset: args.offset,
    };
  },
};

export default ExpensesQuery;
