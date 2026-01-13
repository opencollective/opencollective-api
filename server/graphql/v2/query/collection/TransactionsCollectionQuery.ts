import assert from 'assert';

import config from 'config';
import express from 'express';
import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import { cloneDeep, flatten, intersection, isEmpty, isNil, pick, pickBy, uniq } from 'lodash';
import { Op, type Order as SequelizeOrder, Utils as SequelizeUtils, WhereOptions } from 'sequelize';

import { CollectiveType } from '../../../../constants/collectives';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../../../constants/paymentMethods';
import { TransactionKind } from '../../../../constants/transaction-kind';
import cache, { memoize } from '../../../../lib/cache';
import { mapPlatformTipCollectiveIds, mapPlatformTipDebitsToApplicationFees } from '../../../../lib/ledger-transform';
import { buildSearchConditions } from '../../../../lib/sql-search';
import { parseToBoolean } from '../../../../lib/utils';
import { AccountingCategory, Expense, PaymentMethod, sequelize } from '../../../../models';
import Order from '../../../../models/Order';
import Transaction, { MERCHANT_ID_PATHS } from '../../../../models/Transaction';
import { checkScope } from '../../../common/scope-check';
import { Forbidden, NotFound } from '../../../errors';
import {
  GraphQLTransactionCollection,
  GraphQLTransactionsCollectionReturnType,
} from '../../collection/TransactionCollection';
import { GraphQLExpenseType } from '../../enum/ExpenseType';
import { GraphQLPaymentMethodService } from '../../enum/PaymentMethodService';
import { GraphQLPaymentMethodType } from '../../enum/PaymentMethodType';
import { GraphQLTransactionKind } from '../../enum/TransactionKind';
import { GraphQLTransactionType } from '../../enum/TransactionType';
import {
  fetchAccountsWithReferences,
  fetchAccountWithReference,
  GraphQLAccountReferenceInput,
} from '../../input/AccountReferenceInput';
import { getValueInCentsFromAmountInput } from '../../input/AmountInput';
import { GraphQLAmountRangeInput } from '../../input/AmountRangeInput';
import {
  CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE,
  GraphQLChronologicalOrderInput,
} from '../../input/ChronologicalOrderInput';
import { getDatabaseIdFromExpenseReference, GraphQLExpenseReferenceInput } from '../../input/ExpenseReferenceInput';
import {
  fetchManualPaymentProvidersWithReferences,
  GraphQLManualPaymentProviderReferenceInput,
} from '../../input/ManualPaymentProviderInput';
import { getDatabaseIdFromOrderReference, GraphQLOrderReferenceInput } from '../../input/OrderReferenceInput';
import {
  fetchPaymentMethodWithReferences,
  GraphQLPaymentMethodReferenceInput,
} from '../../input/PaymentMethodReferenceInput';
import {
  fetchPayoutMethodWithReference,
  GraphQLPayoutMethodReferenceInput,
} from '../../input/PayoutMethodReferenceInput';
import { GraphQLVirtualCardReferenceInput } from '../../input/VirtualCardReferenceInput';
import { CollectionArgs } from '../../interface/Collection';

const oneDayInSeconds = 60 * 60 * 24;

const LEDGER_ORDERED_TRANSACTIONS_FIELDS = {
  createdAt: sequelize.literal('ROUND(EXTRACT(epoch FROM "Transaction"."createdAt" AT TIME ZONE \'UTC\') / 10)'),
  clearedAt: sequelize.literal(
    'ROUND(EXTRACT(epoch FROM COALESCE("Transaction"."clearedAt", "Transaction"."createdAt") AT TIME ZONE \'UTC\') / 10)',
  ),
};

const { PLATFORM_TIP, HOST_FEE_SHARE } = TransactionKind;

export const getTransactionKindPriorityCase = tableName => `
  CASE
    WHEN "${tableName}"."kind" IN ('CONTRIBUTION', 'EXPENSE', 'ADDED_FUNDS', 'BALANCE_TRANSFER', 'PREPAID_PAYMENT_METHOD') THEN 1
    WHEN "${tableName}"."kind" IN ('PLATFORM_TIP') THEN 2
    WHEN "${tableName}"."kind" IN ('PLATFORM_TIP_DEBT') THEN 3
    WHEN "${tableName}"."kind" IN ('PAYMENT_PROCESSOR_FEE') THEN 4
    WHEN "${tableName}"."kind" IN ('PAYMENT_PROCESSOR_COVER') THEN 5
    WHEN "${tableName}"."kind" IN ('HOST_FEE') THEN 6
    WHEN "${tableName}"."kind" IN ('HOST_FEE_SHARE') THEN 7
    WHEN "${tableName}"."kind" IN ('HOST_FEE_SHARE_DEBT') THEN 8
    ELSE 9
  END`;

export const TransactionsCollectionArgs = {
  limit: { ...CollectionArgs.limit, defaultValue: 100 },
  offset: CollectionArgs.offset,
  type: {
    type: GraphQLTransactionType,
    description: 'The transaction type (DEBIT or CREDIT)',
  },
  paymentMethodType: {
    type: new GraphQLList(GraphQLPaymentMethodType),
    description: 'The payment method types. Can include `null` for transactions without a payment method',
  },
  paymentMethodService: {
    type: new GraphQLList(GraphQLPaymentMethodService),
    description: 'The payment method services.',
  },
  excludeAccount: {
    type: new GraphQLList(GraphQLAccountReferenceInput),
    description:
      'Reference of the account(s) assigned to the main side of the transaction you want to EXCLUDE from the results',
  },
  fromAccount: {
    type: GraphQLAccountReferenceInput,
    description:
      'Reference of the account assigned to the other side of the transaction (CREDIT -> sender, DEBIT -> recipient). Avoid, favor account instead.',
  },
  host: {
    type: GraphQLAccountReferenceInput,
    description: 'Reference of the host accounting the transaction',
  },
  tags: {
    type: new GraphQLList(GraphQLString),
    description: 'NOT IMPLEMENTED. Only return transactions that match these tags.',
    deprecationReason: '2020-08-09: Was never implemented.',
  },
  orderBy: {
    type: new GraphQLNonNull(GraphQLChronologicalOrderInput),
    description: 'The order of results',
    defaultValue: CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE,
  },
  amount: {
    type: GraphQLAmountRangeInput,
    description: 'Only return expenses that match this amount range',
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
  clearedFrom: {
    type: GraphQLDateTime,
    description: 'Only return transactions that were cleared after this date',
  },
  clearedTo: {
    type: GraphQLDateTime,
    description: 'Only return transactions that were cleared before this date',
  },
  searchTerm: {
    type: GraphQLString,
    description: 'The term to search',
  },
  hasDebt: {
    type: GraphQLBoolean,
    description: 'If true, return transactions with debt attached, if false transactions without debt attached.',
  },
  hasExpense: {
    type: GraphQLBoolean,
    description: 'Only return transactions with an Expense attached',
  },
  expense: {
    type: GraphQLExpenseReferenceInput,
    description: 'Only return transactions with this Expense attached',
  },
  expenseType: {
    type: new GraphQLList(GraphQLExpenseType),
    description: 'Only return transactions that have an Expense of one of these expense types attached',
  },
  hasOrder: {
    type: GraphQLBoolean,
    description: 'Only return transactions with an Order attached',
  },
  order: {
    type: GraphQLOrderReferenceInput,
    description: 'Only return transactions for this order.',
  },
  manualPaymentProvider: {
    type: new GraphQLList(new GraphQLNonNull(GraphQLManualPaymentProviderReferenceInput)),
    description: 'Only return transactions for contributions that used this manual payment provider.',
  },
  includeHost: {
    type: new GraphQLNonNull(GraphQLBoolean),
    defaultValue: true,
    description:
      'Used when filtering with the `host` argument to determine whether to include transactions on the fiscal host account (and children)',
  },
  includePlatformTips: {
    type: new GraphQLNonNull(GraphQLBoolean),
    defaultValue: true,
    description:
      'When filtering with the `host` argument, also include virtual PLATFORM_TIP transactions related to Contributions via TransactionGroup',
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
  kind: {
    type: new GraphQLList(GraphQLTransactionKind),
    description: 'To filter by transaction kind',
  },
  group: {
    type: new GraphQLList(GraphQLString),
    description: 'The transactions group to filter by',
  },
  virtualCard: {
    type: new GraphQLList(GraphQLVirtualCardReferenceInput),
  },
  isRefund: {
    type: GraphQLBoolean,
    description: 'Only return transactions that are refunds (or not refunds if false)',
  },
  merchantId: {
    type: new GraphQLList(GraphQLString),
    description: 'Only return transactions that are associated with these external merchant IDs',
  },
  accountingCategory: {
    type: new GraphQLList(GraphQLString),
    description: 'Only return transactions that are associated with these accounting categories',
  },
  paymentMethod: {
    type: new GraphQLList(GraphQLPaymentMethodReferenceInput),
    description: 'Only return transactions that are associated with this payment method',
  },
  payoutMethod: {
    type: GraphQLPayoutMethodReferenceInput,
    description: 'Only return transactions that are associated with this payout method',
  },
};

export const TransactionsCollectionResolver = async (
  args,
  req: express.Request,
): Promise<GraphQLTransactionsCollectionReturnType> => {
  const where: WhereOptions<Transaction> = [];
  const include = [];

  // Check Pagination arguments
  if (isNil(args.limit) || args.limit < 0) {
    args.limit = 100;
  }
  if (isNil(args.offset) || args.offset < 0) {
    args.offset = 0;
  }
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

  const accountIdsWithGiftCardTransactions = args.includeGiftCardTransactions
    ? await getCollectiveIdsWithGiftCardTransactions()
    : [];

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
      req.remoteUser.CollectiveId === fromAccount.id &&
      checkScope(req, 'incognito')
    ) {
      const incognitoProfile = await fromAccount.getIncognitoProfile();
      if (incognitoProfile) {
        fromAccountCondition.push(incognitoProfile.id);
      }
    }

    if (args.includeGiftCardTransactions && accountIdsWithGiftCardTransactions.includes(fromAccount.id)) {
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
    const attributes = ['id', 'HostCollectiveId']; // We only need IDs
    const fetchAccountsParams = { throwIfMissing: true, attributes };
    if (args.includeChildrenTransactions) {
      fetchAccountsParams['include'] = [
        { association: 'children', required: false, attributes, where: { type: { [Op.ne]: CollectiveType.VENDOR } } },
      ];
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
    if (req.remoteUser && args.includeIncognitoTransactions && checkScope(req, 'incognito')) {
      if (accountCondition.includes(req.remoteUser.CollectiveId)) {
        const incognitoProfile = await req.remoteUser.getIncognitoProfile();
        if (incognitoProfile) {
          accountCondition.push(incognitoProfile.id);
        }
      }
    }

    if (args.includeGiftCardTransactions && intersection(accountsIds, accountIdsWithGiftCardTransactions).length > 0) {
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

    // Database optimization, it seems faster to add the HostCollectiveId if possible
    // Only do this when they are multiple accountsIds and one of them has many transactions
    if (
      accountsIds.length > 1 &&
      intersection(config.performance.collectivesWithManyTransactions, accountsIds).length > 0
    ) {
      const hostCollectiveIds = uniq(accounts.map(account => account.HostCollectiveId).filter(el => !!el));
      if (hostCollectiveIds.length === 1) {
        where.push({ HostCollectiveId: hostCollectiveIds[0] });
      }
    }
  }
  if (!isEmpty(args.excludeAccount)) {
    const attributes = ['id', 'HostCollectiveId']; // We only need IDs
    const fetchAccountsParams = { throwIfMissing: true, attributes };
    if (args.includeChildrenTransactions) {
      fetchAccountsParams['include'] = [{ association: 'children', required: false, attributes }];
    }

    // Fetch accounts (and optionally their children)
    const excludedAccounts = await fetchAccountsWithReferences(args.excludeAccount, fetchAccountsParams);
    const exludedAccountsIds = uniq(
      flatten(
        excludedAccounts.map(account => {
          const accountIds = args.includeRegularTransactions ? [account.id] : [];
          const childrenIds = account.children?.map(child => child.id) || [];
          return [...accountIds, ...childrenIds];
        }),
      ),
    );
    where.push({ CollectiveId: { [Op.notIn]: exludedAccountsIds } });
  }

  if (host) {
    if (args.includeHost === false) {
      const hostChildrenIds = await host
        .getChildren({ attributes: ['id'] })
        .then(children => children.map(child => child.id));
      const hostAccountsIds = [host.id, ...hostChildrenIds];

      where.push({ CollectiveId: { [Op.notIn]: hostAccountsIds } });
    }

    if (args.includePlatformTips) {
      // Include transactions accounted by the host, and also PLATFORM_TIP transactions related to the host via TransactionGroup.
      // Use a UNION subquery to avoid a large OR bitmap scan on Transactions.
      const hostId = sequelize.escape(host.id);
      where.push(
        sequelize.literal(`"Transaction"."id" IN (
          SELECT t."id"
          FROM "Transactions" t
          WHERE t."HostCollectiveId" = ${hostId}
            AND t."deletedAt" IS NULL
          UNION ALL
          SELECT t."id"
          FROM "Transactions" t
          WHERE t."kind" = 'PLATFORM_TIP'
            AND t."deletedAt" IS NULL
            AND EXISTS (
              SELECT 1 FROM "Transactions" t1
              WHERE t1."TransactionGroup" = t."TransactionGroup"
                AND t1."HostCollectiveId" = ${hostId}
                AND (t1."kind" IN ('CONTRIBUTION'))
                AND t1."deletedAt" IS NULL
            )
        )`),
      );
    } else {
      where.push({ HostCollectiveId: host.id });
    }
  }

  // Store the current where as it will be later used to fetch available kinds and paymentMethodTypes
  const baseWhere = cloneDeep(where);

  // Handle search query
  const searchTermConditions = buildSearchConditions(args.searchTerm, {
    idFields: ['id', 'ExpenseId', 'OrderId'],
    slugFields: ['$fromCollective.slug$', '$collective.slug$'],
    textFields: ['$fromCollective.name$', '$collective.name$', 'description'],
    amountFields: ['amount'],
  });

  if (searchTermConditions.length) {
    where.push({ [Op.or]: searchTermConditions });
    include.push({ association: 'fromCollective', attributes: [] }, { association: 'collective', attributes: [] }); // Must include associations to search their fields
  }

  if (args.type) {
    where.push({ type: args.type });
  }

  if (!isEmpty(args.group)) {
    where.push({ TransactionGroup: { [Op.in]: args.group } });
  }

  if (args.amount?.gte || args.amount?.lte) {
    if (args.amount.gte && args.amount.lte) {
      assert(args.amount.gte.currency === args.amount.lte.currency, 'Amount range must have the same currency');
    }
    const currency = args.amount.gte?.currency || args.amount.lte?.currency;
    const gte = args.amount.gte && getValueInCentsFromAmountInput(args.amount.gte);
    const lte = args.amount.lte && getValueInCentsFromAmountInput(args.amount.lte);
    const operator =
      args.amount.gte && args.amount.lte
        ? gte === lte
          ? { [Op.eq]: gte }
          : { [Op.between]: [gte, lte] }
        : args.amount.gte
          ? { [Op.gte]: gte }
          : { [Op.lte]: lte };

    where.push(
      host && host.currency === currency
        ? sequelize.where(sequelize.fn('abs', sequelize.col('amountInHostCurrency')), operator) // If host currency matches, use amountInHostCurrency
        : sequelize.where(
            sequelize.literal(
              SequelizeUtils.formatNamedParameters(
                `
            CASE
              WHEN "Transaction"."currency" = :currency THEN ABS("Transaction"."amount")
              WHEN "Transaction"."hostCurrency" = :currency THEN ABS("Transaction"."amountInHostCurrency")
              ELSE ABS(
                COALESCE(
                  (SELECT rate FROM "CurrencyExchangeRates" 
                    WHERE "from" = "Transaction"."currency" 
                    AND "to" = :currency 
                    -- Most recent rate that is older than the expense, thanks to the combination of "<=" + ORDER BY DESC + LIMIT 1
                    AND "createdAt" <= COALESCE("Transaction"."clearedAt", "Transaction"."createdAt")
                    ORDER BY "createdAt" DESC
                    LIMIT 1
                  ) * "Transaction"."amount",
                  "Transaction"."amount"
                )
              )
            END
          `,
                { currency },
                'postgres',
              ),
            ),
            operator,
          ),
    );
  } else {
    if (args.minAmount) {
      // @ts-expect-error - TODO: fix this
      where.push({ amount: sequelize.where(sequelize.fn('abs', sequelize.col('amount')), Op.gte, args.minAmount) });
    }
    if (args.maxAmount) {
      let amount = sequelize.where(sequelize.fn('abs', sequelize.col('amount')), Op.lte, args.maxAmount);
      if (where['amount']) {
        // @ts-expect-error - TODO: fix this
        amount = { [Op.and]: [where['amount'], amount] };
      }
      // @ts-expect-error - TODO: fix this
      where.push({ amount });
    }
  }

  if (args.dateFrom) {
    where.push({ createdAt: { [Op.gte]: args.dateFrom } });
  }
  if (args.dateTo) {
    where.push({ createdAt: { [Op.lte]: args.dateTo } });
  }
  if (args.clearedFrom) {
    where.push({ clearedAt: { [Op.gte]: args.clearedFrom } });
  }
  if (args.clearedTo) {
    where.push({ clearedAt: { [Op.lte]: args.clearedTo } });
  }
  if (args.expense) {
    const expenseId = getDatabaseIdFromExpenseReference(args.expense);
    where.push({ ExpenseId: expenseId });
  }
  if (args.hasExpense !== undefined) {
    where.push({ ExpenseId: { [args.hasExpense ? Op.ne : Op.eq]: null } });
  }
  if (args.expenseType) {
    include.push({
      model: Expense,
      attributes: [],
      required: true,
      where: { type: { [Op.in]: args.expenseType } },
    });
  }
  if (args.order) {
    const orderId = getDatabaseIdFromOrderReference(args.order);
    where.push({ OrderId: orderId });
  }
  if (args.hasOrder !== undefined) {
    where.push({ OrderId: { [args.hasOrder ? Op.ne : Op.eq]: null } });
  }
  if (!args.includeDebts) {
    where.push({ isDebt: false });
  }
  if (args.kind) {
    where.push({ kind: args.kind });
  }

  if (args.manualPaymentProvider) {
    const providers = await fetchManualPaymentProvidersWithReferences(args.manualPaymentProvider, {
      loaders: req.loaders,
      throwIfMissing: true,
    });
    providers.forEach(provider => {
      assert(
        req.remoteUser?.isAdmin(provider.CollectiveId),
        new Forbidden('You need to be an admin of the host that owns this payment provider to filter by it'),
      );
    });
    include.push({
      model: Order,
      attributes: [],
      required: true,
      where: { ManualPaymentProviderId: providers.map(provider => provider.id) },
    });
  }

  if (args.paymentMethod) {
    const paymentMethods = await fetchPaymentMethodWithReferences(args.paymentMethod);
    assert(
      paymentMethods.every(pm => req.remoteUser?.isAdmin(pm.CollectiveId)),
      new Forbidden("You need to be an admin of the payment method's collective to access this resource"),
    );
    where.push({ PaymentMethodId: { [Op.in]: [...new Set(paymentMethods.map(pm => pm.id))] } });
  } else if (args.paymentMethodService || args.paymentMethodType) {
    const services = uniq(args.paymentMethodService);
    const hasOpenCollective = !services?.length || services.includes(PAYMENT_METHOD_SERVICE.OPENCOLLECTIVE);
    const types = uniq(args.paymentMethodType?.map(type => type || PAYMENT_METHOD_TYPE.MANUAL)); // We historically used 'null' to fetch for manual payments
    const hasManual = hasOpenCollective && (!types?.length || types.includes(PAYMENT_METHOD_TYPE.MANUAL));
    const hasOnlyManual = hasManual && services?.length <= 1 && types?.length === 1;

    if (hasOnlyManual) {
      where.push({ PaymentMethodId: { [Op.is]: null } });
    } else {
      include.push({
        model: PaymentMethod,
        required: !hasManual,
        where: pickBy({ service: !isEmpty(services) && services, type: !isEmpty(types) && types }, Boolean),
      });
      if (hasManual) {
        where.push({
          [Op.or]: [{ PaymentMethodId: { [Op.is]: null } }, { '$PaymentMethod.id$': { [Op.not]: null } }],
        });
      }
    }
  }

  if (args.payoutMethod) {
    const payoutMethod = await fetchPayoutMethodWithReference(args.payoutMethod);
    assert(payoutMethod, new NotFound('Requested payment method not found'));
    assert(
      req.remoteUser?.isAdmin(payoutMethod.CollectiveId),
      new Forbidden("You need to be an admin of the payment method's collective to access this resource"),
    );
    where.push({ PayoutMethodId: payoutMethod.id });
  }

  if (!isEmpty(args.virtualCard)) {
    include.push({
      attributes: [],
      model: Expense,
      required: true,
      where: {
        VirtualCardId: uniq(args.virtualCard.map(vc => vc.id)),
      },
    });
  }

  if (!isEmpty(args.merchantId)) {
    const conditionals = [
      ...MERCHANT_ID_PATHS.CONTRIBUTION.map(path => ({ [path]: { [Op.in]: args.merchantId } })),
      ...MERCHANT_ID_PATHS.EXPENSE.map(path => ({ [path]: { [Op.in]: args.merchantId } })),
    ];
    where.push({ [Op.or]: conditionals });
  }

  if (!isEmpty(args.accountingCategory)) {
    const conditionals = flatten(
      uniq(args.accountingCategory).map(code => [
        { '$Order.accountingCategory.code$': code },
        { '$Expense.accountingCategory.code$': code },
      ]),
    );
    where.push({ [Op.or]: conditionals });
    include.push(
      { model: Expense, required: false, include: [{ model: AccountingCategory, as: 'accountingCategory' }] },
      { model: Order, required: false, include: [{ model: AccountingCategory, as: 'accountingCategory' }] },
    );
  }

  if (!isNil(args.isRefund)) {
    where.push({ isRefund: args.isRefund });
  }

  if (args.hasDebt !== undefined) {
    const hasDebtSubquery = `SELECT id FROM "Transactions" as "DebtTransaction"
      WHERE "DebtTransaction"."TransactionGroup" = "Transaction"."TransactionGroup"
      AND ("DebtTransaction".kind)::text = CONCAT(("Transaction"."kind")::text, '_DEBT')
      AND "DebtTransaction"."type" != "Transaction"."type"
      AND "DebtTransaction"."deletedAt" IS NULL`;
    if (args.hasDebt === true) {
      where.push({ kind: [PLATFORM_TIP, HOST_FEE_SHARE] }); // Need to be this kind to have debt
      where.push(sequelize.literal(`EXISTS (${hasDebtSubquery})`));
    } else if (args.hasDebt === false) {
      where.push(
        sequelize.or(
          { kind: { [Op.not]: [PLATFORM_TIP, HOST_FEE_SHARE] } }, // No Debt if not this kind
          sequelize.literal(`NOT EXISTS (${hasDebtSubquery})`),
        ),
      );
    }
  }

  /* 
    Ordering of transactions by
    - createdAt (rounded by a 10s interval): to treat very close timestamps as the same to defer ordering to transaction group, kind and type
      - known issue: a transaction group can be split in two if the first transaction is rounded to the end of a 10s interval and the second to the beginning of the next 10s interval
    - TransactionGroup: to keep transactions of the same group together
    - kind: to put transactions in a group in a "logical" order following the main transaction
    - type: to put debits before credits of the same kind (i.e. when viewing multiple accounts at the same time)
  */

  const order: SequelizeOrder = parseToBoolean(config.ledger.orderedTransactions)
    ? [
        [LEDGER_ORDERED_TRANSACTIONS_FIELDS[args.orderBy.field || 'createdAt'], args.orderBy.direction],
        ['TransactionGroup', args.orderBy.direction],
        [sequelize.literal(getTransactionKindPriorityCase('Transaction')), args.orderBy.direction],
        [
          sequelize.literal(`
        CASE
          WHEN "Transaction"."type" = 'DEBIT' THEN 1
          ELSE 2
        END`),
          args.orderBy.direction,
        ],
      ]
    : [
        [
          args.orderBy.field === 'clearedAt'
            ? sequelize.literal('COALESCE("Transaction"."clearedAt", "Transaction"."createdAt")')
            : args.orderBy.field,
          args.orderBy.direction,
        ],
        // Add additional sort for consistent sorting
        // (transactions in the same TransactionGroup usually have the exact same datetime)
        ['id', args.orderBy.direction],
      ];

  const { offset, limit } = args;

  const queryParameters = {
    where: sequelize.and(...where),
    order,
    offset,
    limit,
    include,
  };

  return {
    nodes: async () => {
      const transactions = await Transaction.findAll(queryParameters);
      if (args.includePlatformTips) {
        const mappedTransactions = await mapPlatformTipCollectiveIds(transactions, req);
        return mapPlatformTipDebitsToApplicationFees(mappedTransactions, req);
      }
      return transactions;
    },
    totalCount: () => fetchTransactionsCount(queryParameters),
    limit: args.limit,
    offset: args.offset,
    kinds: () => fetchTransactionsKinds(baseWhere),
    paymentMethodTypes: () => fetchTransactionsPaymentMethodTypes(baseWhere),
  };
};

const getCacheKey = (resource, condition) => {
  if (
    Object.keys(condition).length === 1 &&
    condition.HostCollectiveId &&
    config.performance.hostsWithManyTransactions.includes(condition.HostCollectiveId)
  ) {
    return `transactions_${resource}_HostCollectiveId_${condition.HostCollectiveId}`;
  }
  if (Object.keys(condition).length === 1 && condition.CollectiveId) {
    const collectiveIds = Array.isArray(condition.CollectiveId) ? condition.CollectiveId : [condition.CollectiveId];
    if (intersection(config.performance.collectivesWithManyTransactions, collectiveIds).length > 0) {
      return `transactions_${resource}_CollectiveId_${collectiveIds.join('_')}`;
    }
  }
};

const fetchWithCache = async (resource: string, condition, fetchFunction: () => Promise<any>) => {
  let cacheKey;
  if (condition) {
    cacheKey = getCacheKey(resource, condition);
  }
  if (cacheKey) {
    const fromCache = await cache.get(cacheKey);
    if (fromCache) {
      return fromCache;
    }
  }
  const results = await fetchFunction();
  if (cacheKey) {
    cache.set(cacheKey, results, oneDayInSeconds);
  }
  return results;
};

const fetchTransactionsKinds = async whereKinds => {
  const condition = whereKinds.length === 1 ? whereKinds[0] : null;

  return fetchWithCache('kinds', condition, () =>
    Transaction.findAll({
      attributes: ['kind'],
      where: whereKinds,
      group: ['kind'],
      raw: true,
    }).then(results => results.map(m => m.kind).filter(kind => !!kind)),
  );
};

const fetchTransactionsPaymentMethodTypes = async whereKinds => {
  const condition = whereKinds.length === 1 ? whereKinds[0] : null;

  return fetchWithCache('paymentMethodTypes', condition, () =>
    Transaction.findAll({
      attributes: ['PaymentMethod.type'],
      where: whereKinds,
      include: [{ model: PaymentMethod, required: false, attributes: [] }],
      group: ['PaymentMethod.type'],
      raw: true,
    }).then(results => results.map(result => result.type || null)),
  );
};

const fetchTransactionsCount = async (queryParameters): Promise<number> => {
  const condition = queryParameters.where[Op.and].length === 1 ? queryParameters.where[Op.and][0] : null;

  return fetchWithCache('count', condition, () => Transaction.count(pick(queryParameters, ['where', 'include'])));
};

const getCollectiveIdsWithGiftCardTransactions = memoize(
  (): Promise<number[]> =>
    Transaction.findAll({
      attributes: ['UsingGiftCardFromCollectiveId'],
      where: { UsingGiftCardFromCollectiveId: { [Op.not]: null } },
      group: ['UsingGiftCardFromCollectiveId'],
      raw: true,
    }).then(results => results.map(result => result.UsingGiftCardFromCollectiveId)),
  { key: 'collectiveIdsWithGiftCardTransactions', maxAge: oneDayInSeconds },
);

const TransactionsCollectionQuery = {
  type: new GraphQLNonNull(GraphQLTransactionCollection),
  args: {
    account: {
      type: new GraphQLList(new GraphQLNonNull(GraphQLAccountReferenceInput)),
      description:
        'Reference of the account(s) assigned to the main side of the transaction (CREDIT -> recipient, DEBIT -> sender)',
    },
    ...TransactionsCollectionArgs,
  },
  async resolve(_: void, args, req: express.Request): Promise<GraphQLTransactionsCollectionReturnType> {
    return TransactionsCollectionResolver(args, req);
  },
};

export default TransactionsCollectionQuery;
