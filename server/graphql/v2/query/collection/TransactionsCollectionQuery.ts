import express from 'express';
import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-iso-date';
import { cloneDeep, flatten, uniq } from 'lodash';

import models, { Op, sequelize } from '../../../../models';
import { TransactionCollection } from '../../collection/TransactionCollection';
import { TransactionKind } from '../../enum/TransactionKind';
import { TransactionType } from '../../enum/TransactionType';
import {
  AccountReferenceInput,
  fetchAccountsWithReferences,
  fetchAccountWithReference,
} from '../../input/AccountReferenceInput';
import { CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE, ChronologicalOrderInput } from '../../input/ChronologicalOrderInput';
import { CollectionArgs, TransactionsCollectionReturnType } from '../../interface/Collection';

const TransactionsCollectionQuery = {
  type: new GraphQLNonNull(TransactionCollection),
  args: {
    ...CollectionArgs,
    type: {
      type: TransactionType,
      description: 'The transaction type (DEBIT or CREDIT)',
    },
    fromAccount: {
      type: AccountReferenceInput,
      description:
        'Reference of the account assigned to the other side of the transaction (CREDIT -> sender, DEBIT -> recipient). Avoid, favor account instead.',
    },
    account: {
      type: new GraphQLList(new GraphQLNonNull(AccountReferenceInput)),
      description:
        'Reference of the account(s) assigned to the main side of the transaction (CREDIT -> recipient, DEBIT -> sender)',
    },
    host: {
      type: AccountReferenceInput,
      description: 'Reference of the host accounting the transaction',
    },
    tags: {
      type: new GraphQLList(GraphQLString),
      description: 'NOT IMPLEMENTED. Only return transactions that match these tags.',
      deprecationReason: '2020-08-09: Was never implemented.',
    },
    orderBy: {
      type: new GraphQLNonNull(ChronologicalOrderInput),
      description: 'The order of results',
      defaultValue: CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE,
    },
    minAmount: {
      type: GraphQLInt,
      description: 'Only return transactions where the amount is greater than or equal to this value (in cents)',
      deprecationReason: '2020-08-09: GraphQL v2 should not expose amounts as integer.',
    },
    maxAmount: {
      type: GraphQLInt,
      description: 'Only return transactions where the amount is lower than or equal to this value (in cents)',
      deprecationReason: '2020-08-09: GraphQL v2 should not expose amounts as integer.',
    },
    dateFrom: {
      type: GraphQLDateTime,
      description: 'Only return transactions that were created after this date',
    },
    dateTo: {
      type: GraphQLDateTime,
      description: 'Only return transactions that were created before this date',
    },
    searchTerm: {
      type: GraphQLString,
      description: 'The term to search',
    },
    hasExpense: {
      type: GraphQLBoolean,
      description: 'Only return transactions with an Expense attached',
    },
    hasOrder: {
      type: GraphQLBoolean,
      description: 'Only return transactions with an Order attached',
    },
    includeRegularTransactions: {
      type: new GraphQLNonNull(GraphQLBoolean),
      defaultValue: true,
      description:
        'Whether to include regular transactions from the account (turn false if you only want Incognito or Gift Card transactions)',
    },
    includeIncognitoTransactions: {
      type: new GraphQLNonNull(GraphQLBoolean),
      defaultValue: false,
      description:
        'If the account is a user and this field is true, contributions from the incognito profile will be included too (admins only)',
    },
    includeChildrenTransactions: {
      type: new GraphQLNonNull(GraphQLBoolean),
      defaultValue: false,
      description: 'Whether to include transactions from children (Events and Projects)',
    },
    includeGiftCardTransactions: {
      type: new GraphQLNonNull(GraphQLBoolean),
      defaultValue: false,
      description: 'Whether to include transactions from Gift Cards issued by the account.',
    },
    includeDebts: {
      type: new GraphQLNonNull(GraphQLBoolean),
      defaultValue: false,
      description: 'Whether to include debt transactions',
    },
    kinds: {
      type: new GraphQLList(TransactionKind),
      description: 'To filter by transaction kind',
      deprecationReason: '2020-06-30: Please use kind (singular)',
    },
    kind: {
      type: new GraphQLList(TransactionKind),
      description: 'To filter by transaction kind',
    },
  },
  async resolve(_: void, args, req: express.Request): Promise<TransactionsCollectionReturnType> {
    const where = [];
    const include = [];

    // Check arguments
    if (args.limit > 10000 && !req.remoteUser?.isRoot()) {
      throw new Error('Cannot fetch more than 10,000 transactions at the same time, please adjust the limit');
    }

    // Load accounts
    const fetchAccountParams = { loaders: req.loaders, throwIfMissing: true };
    const [fromAccount, host] = await Promise.all(
      [args.fromAccount, args.host].map(
        reference => reference && fetchAccountWithReference(reference, fetchAccountParams),
      ),
    );

    if (fromAccount) {
      const fromAccountCondition = [];

      if (args.includeRegularTransactions) {
        fromAccountCondition.push(fromAccount.id);
      }

      if (args.includeChildrenTransactions) {
        const childIds = await fromAccount.getChildren().then(children => children.map(child => child.id));
        fromAccountCondition.push(...childIds);
      }

      // When users are admins, also fetch their incognito contributions
      if (
        args.includeIncognitoTransactions &&
        req.remoteUser?.isAdminOfCollective(fromAccount) &&
        req.remoteUser.CollectiveId === fromAccount.id
      ) {
        const fromAccountUser = await fromAccount.getUser();
        if (fromAccountUser) {
          const incognitoProfile = await fromAccountUser.getIncognitoProfile();
          if (incognitoProfile) {
            fromAccountCondition.push(incognitoProfile.id);
          }
        }
      }

      if (args.includeGiftCardTransactions) {
        where.push({
          [Op.or]: [
            { UsingGiftCardFromCollectiveId: fromAccount.id, type: 'CREDIT' },
            // prettier, please keep line break for readability please
            { FromCollectiveId: fromAccountCondition },
          ],
        });
      } else {
        where.push({ FromCollectiveId: fromAccountCondition });
      }
    }

    if (args.account) {
      const accountCondition = [];
      const attributes = ['id']; // We only need IDs
      const fetchAccountsParams = { throwIfMissing: true, attributes };
      if (args.includeChildrenTransactions) {
        fetchAccountsParams['include'] = [{ association: 'children', required: false, attributes }];
      }

      // Fetch accounts (and optionally their children)
      const accounts = await fetchAccountsWithReferences(args.account, fetchAccountsParams);
      const accountsIds = uniq(
        flatten(
          accounts.map(account => {
            const accountIds = args.includeRegularTransactions ? [account.id] : [];
            const childrenIds = account.children?.map(child => child.id) || [];
            return [...accountIds, ...childrenIds];
          }),
        ),
      );

      accountCondition.push(...accountsIds);

      // When the remote user is part of the fetched profiles, also fetch the linked incognito contributions
      if (req.remoteUser && args.includeIncognitoTransactions) {
        if (accountCondition.includes(req.remoteUser.CollectiveId)) {
          const incognitoProfile = await req.remoteUser.getIncognitoProfile();
          if (incognitoProfile) {
            accountCondition.push(incognitoProfile.id);
          }
        }
      }

      if (args.includeGiftCardTransactions) {
        where.push({
          [Op.or]: [
            { UsingGiftCardFromCollectiveId: accountsIds, type: 'DEBIT' },
            // prettier, please keep line break for readability please
            { CollectiveId: accountCondition },
          ],
        });
      } else {
        where.push({ CollectiveId: accountCondition });
      }
    }

    if (host) {
      where.push({ HostCollectiveId: host.id });
    }

    // Backup the conditions as they're now to fetch the list of all available kinds
    const whereKinds = cloneDeep(where);

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
    if (args.hasOrder !== undefined) {
      where.push({ OrderId: { [args.hasOrder ? Op.ne : Op.eq]: null } });
    }
    if (!args.includeDebts) {
      where.push({ isDebt: { [Op.not]: true } });
    }
    if (args.kind || args.kinds) {
      where.push({ kind: args.kind || args.kinds });
    }

    const order = [
      [args.orderBy.field, args.orderBy.direction],
      // Add additional sort for consistent sorting
      // (transactions in the same TransactionGroup usually have the exact same datetime)
      ['kind'],
    ];
    const { offset, limit } = args;
    const result = await models.Transaction.findAndCountAll({
      where: sequelize.and(...where),
      limit,
      offset,
      order,
      include,
    });

    return {
      nodes: result.rows,
      totalCount: result.count,
      limit: args.limit,
      offset: args.offset,
      kinds: () => {
        return models.Transaction.findAll({
          attributes: ['kind'],
          where: whereKinds,
          group: ['kind'],
          raw: true,
        }).then(results => results.map(m => m.kind).filter(kind => !!kind));
      },
    };
  },
};

export default TransactionsCollectionQuery;
