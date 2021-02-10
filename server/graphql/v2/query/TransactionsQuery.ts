import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';

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
    host: {
      type: AccountReferenceInput,
      description: 'Reference of the host where this expense was submitted',
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
    dateTo: {
      type: ISODateTime,
      description: 'Only return expenses that were created after this date',
    },
    searchTerm: {
      type: GraphQLString,
      description: 'The term to search',
    },
    hasExpense: {
      type: GraphQLBoolean,
      description: 'Transaction is attached to Expense',
    },
    hasOrder: {
      type: GraphQLBoolean,
      description: 'Transaction is attached to Order',
    },
    includeIncognitoTransactions: {
      type: new GraphQLNonNull(GraphQLBoolean),
      defaultValue: false,
      description:
        'If the account is a user and this field is true, contributions from the incognito profile will be included too (admins only)',
    },
  },
  async resolve(_, args, req): Promise<CollectionReturnType> {
    const where = [];
    const include = [];

    // Check arguments
    if (args.limit > 1000) {
      throw new Error('Cannot fetch more than 1000 transactions at the same time, please adjust the limit');
    }

    // Load accounts
    const fetchAccountParams = { loaders: req.loaders, throwIfMissing: true };
    const [fromAccount, account, host] = await Promise.all(
      [args.fromAccount, args.account, args.host].map(
        reference => reference && fetchAccountWithReference(reference, fetchAccountParams),
      ),
    );
    if (fromAccount) {
      let fromCollectiveCondition = fromAccount.id;
      if (
        args.includeIncognitoTransactions &&
        req.remoteUser?.isAdminOfCollective(fromAccount) &&
        req.remoteUser.CollectiveId === fromAccount.id
      ) {
        const incognitoProfile = await req.remoteUser.getIncognitoProfile();
        if (incognitoProfile) {
          fromCollectiveCondition = { [Op.or]: [fromAccount.id, incognitoProfile.id] };
        }
      }

      where.push({
        [Op.or]: [
          { UsingGiftCardFromCollectiveId: fromAccount.id, type: 'CREDIT' },
          { FromCollectiveId: fromCollectiveCondition },
        ],
      });
    }
    if (account) {
      const accountConditions = [
        { CollectiveId: account.id },
        { UsingGiftCardFromCollectiveId: account.id, type: 'DEBIT' },
      ];

      // When users are admins, also fetch their incognito contributions
      if (
        args.includeIncognitoTransactions &&
        req.remoteUser?.isAdminOfCollective(account) &&
        req.remoteUser.CollectiveId === account.id
      ) {
        const incognitoProfile = await req.remoteUser.getIncognitoProfile();
        if (incognitoProfile) {
          accountConditions.push({ CollectiveId: incognitoProfile.id });
        }
      }

      where.push({ [Op.or]: accountConditions });
    }
    if (host) {
      where.push({ HostCollectiveId: host.id });
    }
    if (args.searchTerm) {
      const sanitizedTerm = args.searchTerm.replace(/(_|%|\\)/g, '\\$1');
      const ilikeQuery = `%${sanitizedTerm}%`;
      const or = [];
      or.push(
        { description: { [Op.iLike]: ilikeQuery } },
        { '$fromCollective.slug$': { [Op.iLike]: ilikeQuery } },
        { '$fromCollective.name$': { [Op.iLike]: ilikeQuery } },
        { '$collective.slug$': { [Op.iLike]: ilikeQuery } },
        { '$collective.name$': { [Op.iLike]: ilikeQuery } },
      );

      include.push({ association: 'fromCollective', attributes: [] }, { association: 'collective', attributes: [] });

      if (!isNaN(args.searchTerm)) {
        or.push({ id: args.searchTerm });
      }

      where.push({
        [Op.or]: or,
      });
    }
    if (args.type) {
      where.push({ type: args.type });
    }
    if (args.minAmount) {
      where.push({ amount: sequelize.where(sequelize.fn('abs', sequelize.col('amount')), Op.gte, args.minAmount) });
    }
    if (args.maxAmount) {
      let amount = sequelize.where(sequelize.fn('abs', sequelize.col('amount')), Op.lte, args.maxAmount);
      if (where['amount']) {
        amount = { [Op.and]: [where['amount'], amount] };
      }
      where.push({ amount });
    }
    if (args.dateFrom) {
      where.push({ createdAt: { [Op.gte]: args.dateFrom } });
    }
    if (args.dateTo) {
      where.push({ createdAt: { [Op.lte]: args.dateTo } });
    }
    if (args.hasExpense !== undefined) {
      where.push({ ExpenseId: { [args.hasExpense ? Op.ne : Op.eq]: null } });
    }
    if (args.hasOrder) {
      where.push({ OrderId: { [Op.ne]: null } });
    }

    const order = [[args.orderBy.field, args.orderBy.direction]];
    const { offset, limit } = args;
    const result = await models.Transaction.findAndCountAll({
      where: sequelize.and(...where),
      limit,
      offset,
      order,
      include,
    });

    return { nodes: result.rows, totalCount: result.count, limit: args.limit, offset: args.offset };
  },
};

export default TransactionsQuery;
