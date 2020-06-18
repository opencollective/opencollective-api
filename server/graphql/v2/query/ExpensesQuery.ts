import { GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';

import models, { Op, sequelize } from '../../../models';
import { PayoutMethodTypes } from '../../../models/PayoutMethod';
import { ExpenseCollection } from '../collection/ExpenseCollection';
import ExpenseStatus from '../enum/ExpenseStatus';
import { ExpenseType } from '../enum/ExpenseType';
import PayoutMethodType from '../enum/PayoutMethodType';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE, ChronologicalOrderInput } from '../input/ChronologicalOrderInput';
import { CollectionArgs, CollectionReturnType } from '../interface/Collection';
import ISODateTime from '../scalar/ISODateTime';

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
    minAmount: {
      type: GraphQLInt,
      description: 'Only return expenses where amount is greater than or equal to this value',
    },
    maxAmount: {
      type: GraphQLInt,
      description: 'Only return expenses where amount is lower than this value',
    },
    payoutMethodType: {
      type: PayoutMethodType,
      description: 'Only return expenses that use the given type as payout method',
    },
    dateFrom: {
      type: ISODateTime,
      description: 'Only return expenses that were created after this date',
    },
  },
  async resolve(_, args, req): Promise<CollectionReturnType> {
    const where = {};
    const include = [];
    const fetchAccountParams = { loaders: req.loaders, throwIfMissing: true };

    // Check arguments
    if (args.limit > 100) {
      throw new Error('Cannot fetch more than 100 expenses at the same time, please adjust the limit');
    }

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
    if (args.minAmount) {
      where['amount'] = { [Op.gte]: args.minAmount };
    }
    if (args.maxAmount) {
      where['amount'] = { ...where['amount'], [Op.lt]: args.maxAmount };
    }
    if (args.dateFrom) {
      where['createdAt'] = { [Op.gte]: args.dateFrom };
    }
    if (args.payoutMethodType) {
      include.push({
        association: 'PayoutMethod',
        attributes: [],
        required: args.payoutMethodType !== PayoutMethodTypes.OTHER,
        where: { type: args.payoutMethodType },
      });

      if (args.payoutMethodType === PayoutMethodTypes.OTHER) {
        where[Op.and] = sequelize.literal(`("PayoutMethodId" IS NULL OR "PayoutMethod".type = 'OTHER')`);
      }
    }

    const order = [[args.orderBy.field, args.orderBy.direction]];
    const { offset, limit } = args;
    const result = await models.Expense.findAndCountAll({ where, include, order, offset, limit });
    return {
      nodes: result.rows,
      totalCount: result.count,
      limit: args.limit,
      offset: args.offset,
    };
  },
};

export default ExpensesQuery;
