import { GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';

import models, { Op, sequelize } from '../../../models';
import { TransactionCollection } from '../collection/TransactionCollection';
import { TransactionType } from '../enum/TransactionType';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE, ChronologicalOrderInput } from '../input/ChronologicalOrderInput';
import { CollectionArgs, CollectionReturnType } from '../interface/Collection';
import ISODateTime from '../scalar/ISODateTime';

const TransactionsQuery = {
  type: TransactionCollection,
  args: {
    ...CollectionArgs,
    type: {
      type: TransactionType,
      description: 'The transaction type (DEBIT or CREDIT)',
    },
    fromAccount: {
      type: AccountReferenceInput,
      description: 'Reference of the account that submitted this expense',
    },
    account: {
      type: AccountReferenceInput,
      description: 'Reference of the account where this expense was submitted',
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

    // Check arguments
    if (args.limit > 100) {
      throw new Error('Cannot fetch more than 100 expenses at the same time, please adjust the limit');
    }

    // Load accounts
    const fetchAccountParams = { loaders: req.loaders, throwIfMissing: true };
    const [fromAccount, account] = await Promise.all(
      [args.fromAccount, args.account].map(
        reference => reference && fetchAccountWithReference(reference, fetchAccountParams),
      ),
    );
    if (fromAccount) {
      where['FromCollectiveId'] = fromAccount.id;
    }
    if (account) {
      where['CollectiveId'] = account.id;
    }
    if (args.searchTerm) {
      const sanitizedTerm = args.searchTerm.replace(/(_|%|\\)/g, '\\$1');
      const ilikeQuery = `%${sanitizedTerm}%`;
      where[Op.or] = [
        { description: { [Op.iLike]: ilikeQuery } },
        { '$fromCollective.slug$': { [Op.iLike]: ilikeQuery } },
        { '$fromCollective.name$': { [Op.iLike]: ilikeQuery } },
        { '$collective.slug$': { [Op.iLike]: ilikeQuery } },
        { '$collective.name$': { [Op.iLike]: ilikeQuery } },
      ];

      include.push(
        { association: 'fromCollective', attributes: [] },
        { association: 'collective', attributes: [] },
        // One-to-many relationships with limits are broken in Sequelize. Could be fixed by https://github.com/sequelize/sequelize/issues/4376
        // { association: 'items', duplicating: false, attributes: [], separate: true },
      );

      if (!isNaN(args.searchTerm)) {
        where[Op.or].push({ id: args.searchTerm });
      }
    }
    if (args.type) {
      where['type'] = args.type;
    }
    if (args.minAmount) {
      where['amount'] = sequelize.where(sequelize.fn('abs', sequelize.col('amount')), Op.gte, args.minAmount);
    }
    if (args.maxAmount) {
      let condition = sequelize.where(sequelize.fn('abs', sequelize.col('amount')), Op.lte, args.maxAmount);
      if (where['amount']) {
        condition = { [Op.and]: [where['amount'], condition] };
      }
      where['amount'] = condition;
    }
    if (args.dateFrom) {
      where['createdAt'] = { [Op.gte]: args.dateFrom };
    }

    const order = [[args.orderBy.field, args.orderBy.direction]];
    const { offset, limit } = args;
    const result = await models.Transaction.findAndCountAll({
      where,
      limit,
      offset,
      order,
      include,
    });

    return { nodes: result.rows, totalCount: result.count, limit: args.limit, offset: args.offset };
  },
};

export default TransactionsQuery;
