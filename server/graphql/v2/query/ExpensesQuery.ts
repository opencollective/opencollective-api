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
      description: 'Only return expenses where the amount is greater than or equal to this value (in cents)',
    },
    maxAmount: {
      type: GraphQLInt,
      description: 'Only return expenses where the amount is lower than or equal to this value (in cents)',
    },
    payoutMethodType: {
      type: PayoutMethodType,
      description: 'Only return expenses that use the given type as payout method',
    },
    dateFrom: {
      type: ISODateTime,
      description: 'Only return expenses that were created after this date',
    },
    searchTerm: {
      type: GraphQLString,
      description: 'The term to search',
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

    // Add search filter
    if (args.searchTerm) {
      const sanitizedTerm = args.searchTerm.replace(/(_|%|\\)/g, '\\$1');
      const ilikeQuery = `%${sanitizedTerm}%`;
      where[Op.or] = [
        { description: { [Op.iLike]: ilikeQuery } },
        { tags: { [Op.overlap]: [args.searchTerm.toLowerCase()] } },
        { '$fromCollective.slug$': { [Op.iLike]: ilikeQuery } },
        { '$fromCollective.name$': { [Op.iLike]: ilikeQuery } },
        // { '$items.description$': { [Op.iLike]: ilikeQuery } },
      ];

      include.push(
        { association: 'fromCollective', attributes: [] },
        // One-to-many relationships with limits are broken in Sequelize. Could be fixed by https://github.com/sequelize/sequelize/issues/4376
        // { association: 'items', duplicating: false, attributes: [], separate: true },
      );

      if (!isNaN(args.searchTerm)) {
        where[Op.or].push({ id: args.searchTerm });
      }
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
      where['amount'] = { ...where['amount'], [Op.lte]: args.maxAmount };
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
    const result = await models.Expense.findAndCountAll({ include, where, order, offset, limit });
    return {
      nodes: result.rows,
      totalCount: result.count,
      limit: args.limit,
      offset: args.offset,
    };
  },
};

export default ExpensesQuery;
