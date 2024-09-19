import express from 'express';
import { GraphQLNonNull } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import { isNil } from 'lodash';

import { SupportedCurrency } from '../../../../constants/currencies';
import { getFxRate } from '../../../../lib/currency';
import { Op, sequelize } from '../../../../models';
import Transaction from '../../../../models/Transaction';
import { GraphQLTransactionGroupCollection } from '../../collection/TransactionGroupCollection';
import { GraphQLTransactionType } from '../../enum/TransactionType';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../../input/AccountReferenceInput';
import { CollectionArgs, CollectionReturnType } from '../../interface/Collection';

import { getTransactionKindPriorityCase } from './TransactionsCollectionQuery';
import { GraphQLTransactionKind } from '../../enum/TransactionKind';

export const TransactionGroupCollectionArgs = {
  limit: { ...CollectionArgs.limit, defaultValue: 100 },
  offset: CollectionArgs.offset,
  type: {
    type: GraphQLTransactionType,
    description: 'Filter transaction groups by the type of the primary transaction',
  },
  kind: {
    type: GraphQLTransactionKind,
    description: 'Filter transaction groups by the kind of the primary transaction',
  },
  dateFrom: {
    type: GraphQLDateTime,
    description: 'Only return transaction groups that were created after this date',
  },
  dateTo: {
    type: GraphQLDateTime,
    description: 'Only return transaction groups that were created before this date',
  },
};

export const TransactionGroupCollectionResolver = async (args, req: express.Request): Promise<CollectionReturnType> => {
  const account = await fetchAccountWithReference(args.account);

  // Check Pagination arguments
  if (isNil(args.limit) || args.limit < 0) {
    args.limit = 100;
  }
  if (isNil(args.offset) || args.offset < 0) {
    args.offset = 0;
  }
  if (args.limit > 1000 && !req.remoteUser?.isRoot()) {
    throw new Error('Cannot fetch more than 1,000 transaction groups at the same time, please adjust the limit');
  }
  const where = [];
  where.push({ CollectiveId: account.id });

  if (args.dateFrom) {
    where.push({ createdAt: { [Op.gte]: args.dateFrom } });
  }
  if (args.dateTo) {
    where.push({ createdAt: { [Op.lte]: args.dateTo } });
  }

  const primaryTransactionIdSubquery = `
    (SELECT t2."id"
    FROM "Transactions" "t2"
    WHERE "t2"."TransactionGroup" = "Transaction"."TransactionGroup"
    AND "t2"."CollectiveId" = ${account.id}
    ORDER BY ${getTransactionKindPriorityCase('t2')}, "t2"."id" ASC LIMIT 1)
  `;

  if (args.type) {
    where.push({
      [Op.and]: sequelize.literal(
        `EXISTS (
            SELECT 1 FROM "Transactions" t3
            WHERE t3."id" = (${primaryTransactionIdSubquery})
              AND t3."type" = '${args.type}'
          )`,
      ),
    });
  }

  if (args.kind) {
    where.push({
      [Op.and]: sequelize.literal(
        `EXISTS (
            SELECT 1 FROM "Transactions" t4
            WHERE t4."id" = (${primaryTransactionIdSubquery})
              AND t4."kind" = '${args.kind}'
          )`,
      ),
    });
  }

  const transactionGroupsByCurrency = (await Transaction.findAll({
    where: sequelize.and(...where),
    attributes: [
      'TransactionGroup',
      'currency',
      [sequelize.fn('SUM', sequelize.col('netAmountInCollectiveCurrency')), 'sumAmount'],
      [sequelize.fn('MIN', sequelize.col('createdAt')), 'minCreatedAt'],
      [sequelize.literal(`(${primaryTransactionIdSubquery})`), 'primaryTransactionId'],
    ],
    group: ['TransactionGroup', 'currency'],
    order: [['minCreatedAt', 'DESC']],
    limit: args.limit,
    offset: args.offset,
    raw: true,
  })) as any as {
    TransactionGroup: string;
    currency: SupportedCurrency;
    sumAmount: number;
    minCreatedAt: Date;
    primaryTransactionId: string;
  }[];

  const transactionGroupsInAccountCurrency = await Promise.all(
    transactionGroupsByCurrency.map(async group => {
      const fxRate = await getFxRate(group.currency, account.currency, group.minCreatedAt);
      const amountInAccountCurrency = Math.round(group.sumAmount * fxRate);

      return {
        id: group.TransactionGroup,
        amount: {
          value: amountInAccountCurrency,
          currency: account.currency,
        },
        primaryTransactionId: group.primaryTransactionId,
        accountId: account.id,
        createdAt: group.minCreatedAt,
      };
    }),
  );

  const transactionGroups = Object.values(
    transactionGroupsInAccountCurrency.reduce((acc, group) => {
      if (!acc[group.id]) {
        acc[group.id] = { ...group, amount: { value: 0, currency: account.currency } };
      }
      acc[group.id].amount.value += group.amount.value;
      if (new Date(group.createdAt) < new Date(acc[group.id].createdAt)) {
        acc[group.id].createdAt = group.createdAt;
      }
      return acc;
    }, {}),
  );

  return {
    nodes: transactionGroups,
    totalCount: async () => {
      const { totalCount } = (await Transaction.findOne({
        where: sequelize.and(...where),
        attributes: [
          [sequelize.fn('COUNT', sequelize.fn('DISTINCT', sequelize.col('TransactionGroup'))), 'totalCount'],
        ],
        raw: true,
      })) as any as {
        totalCount: number;
      };
      return totalCount;
    },
    limit: args.limit,
    offset: args.offset,
  };
};

const TransactionGroupCollectionQuery = {
  type: new GraphQLNonNull(GraphQLTransactionGroupCollection),
  description: '[!] Warning: this query is currently in beta and the API might change',
  args: {
    account: {
      type: new GraphQLNonNull(GraphQLAccountReferenceInput),
      description:
        'Reference of the account(s) assigned to the main side of the transaction group (CREDIT -> recipient, DEBIT -> sender)',
    },
    ...TransactionGroupCollectionArgs,
  },
  async resolve(_: void, args, req: express.Request): Promise<CollectionReturnType> {
    return TransactionGroupCollectionResolver(args, req);
  },
};

export default TransactionGroupCollectionQuery;
