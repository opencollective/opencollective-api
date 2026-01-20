import assert from 'assert';

import express from 'express';
import {
  GraphQLBoolean,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLString,
} from 'graphql';
import { GraphQLDateTime, GraphQLJSON } from 'graphql-scalars';
import { compact, isEmpty, isNil, sum, uniq } from 'lodash';
import { OrderItem, Sequelize, Utils as SequelizeUtils, WhereOptions } from 'sequelize';

import { expenseStatus } from '../../../../constants';
import ActivityTypes from '../../../../constants/activities';
import { CollectiveType } from '../../../../constants/collectives';
import { SupportedCurrency } from '../../../../constants/currencies';
import MemberRoles from '../../../../constants/roles';
import { getBalances } from '../../../../lib/budget';
import { loadFxRatesMap } from '../../../../lib/currency';
import { buildSearchConditions } from '../../../../lib/sql-search';
import { expenseMightBeSubjectToTaxForm } from '../../../../lib/tax-forms';
import { AccountingCategory, Activity, Collective, Op, sequelize } from '../../../../models';
import Expense, { ExpenseType } from '../../../../models/Expense';
import { PayoutMethodTypes } from '../../../../models/PayoutMethod';
import { validateExpenseCustomData } from '../../../common/expenses';
import { Forbidden, NotFound, Unauthorized } from '../../../errors';
import { GraphQLExpenseCollection } from '../../collection/ExpenseCollection';
import { GraphQLActivityType } from '../../enum/ActivityType';
import GraphQLExpenseStatusFilter from '../../enum/ExpenseStatusFilter';
import { GraphQLExpenseType } from '../../enum/ExpenseType';
import GraphQLHostContext from '../../enum/HostContext';
import { GraphQLLastCommentBy } from '../../enum/LastCommentByType';
import { GraphQLPayoutMethodType } from '../../enum/PayoutMethodType';
import {
  fetchAccountsWithReferences,
  fetchAccountWithReference,
  GraphQLAccountReferenceInput,
} from '../../input/AccountReferenceInput';
import { getValueInCentsFromAmountInput } from '../../input/AmountInput';
import { AmountRangeInputType, GraphQLAmountRangeInput } from '../../input/AmountRangeInput';
import {
  CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE,
  GraphQLChronologicalOrderInput,
} from '../../input/ChronologicalOrderInput';
import {
  fetchPayoutMethodWithReference,
  GraphQLPayoutMethodReferenceInput,
} from '../../input/PayoutMethodReferenceInput';
import { GraphQLVirtualCardReferenceInput } from '../../input/VirtualCardReferenceInput';
import { CollectionArgs, CollectionReturnType } from '../../interface/Collection';
import { UncategorizedValue } from '../../object/AccountingCategory';

const updateFilterConditionsForReadyToPay = async (where, include, host, loaders): Promise<void> => {
  where['status'] = expenseStatus.APPROVED;
  where['onHold'] = false;

  // Get all collectives matching the search that have APPROVED expenses
  const expenses = await Expense.findAll({
    where,
    include,
    attributes: [
      'Expense.id',
      'Expense.type',
      'FromCollectiveId',
      'CollectiveId',
      'Expense.currency',
      'Expense.amount',
    ],
    group: ['Expense.id', 'Expense.FromCollectiveId', 'Expense.CollectiveId'],
    raw: true,
  });

  // Check tax forms
  const expensesIdsPendingTaxForms = new Set();
  let checkTaxForms = true;

  // No need to trigger the full query if the host doesn't have any tax forms requirement
  if (host) {
    const legalDocsCount = await host.countRequiredLegalDocuments({ where: { documentType: 'US_TAX_FORM' } });
    checkTaxForms = legalDocsCount > 0;
  }

  if (checkTaxForms) {
    const expensesSubjectToTaxForm = expenses.filter(expenseMightBeSubjectToTaxForm);
    if (expensesSubjectToTaxForm.length > 0) {
      const expenseIds = expensesSubjectToTaxForm.map(expense => expense.id);
      const requiredLegalDocs = await loaders.Expense.taxFormRequiredBeforePayment.loadMany(expenseIds);
      requiredLegalDocs.forEach((required, i) => {
        if (required) {
          expensesIdsPendingTaxForms.add(expenseIds[i]);
        }
      });

      where[Op.and].push({ id: { [Op.notIn]: Array.from(expensesIdsPendingTaxForms) } });
    }
  }

  // Tiny optimization: don't compute the balance for expenses that are pending tax forms
  const hasPendingTaxForm = expense => !expensesIdsPendingTaxForms.has(expense.id);
  const expensesWithoutPendingTaxForm = expensesIdsPendingTaxForms.size ? expenses.filter(hasPendingTaxForm) : expenses;
  if (!isEmpty(expensesWithoutPendingTaxForm)) {
    // Check the balances for these collectives. The following will emit an SQL like:
    // AND ((CollectiveId = 1 AND amount < 5000) OR (CollectiveId = 2 AND amount < 3000))
    const collectiveIds = uniq(expensesWithoutPendingTaxForm.map(e => e.CollectiveId));
    // TODO: this can conflict for collectives stuck on balance v1 as this is now using balance v2 by default
    const balances = await getBalances(collectiveIds, { withBlockedFunds: true });
    const fxRates = await loadFxRatesMap(
      uniq(
        expensesWithoutPendingTaxForm.map(expense => {
          const collectiveBalance = balances[expense.CollectiveId];
          return { fromCurrency: expense.currency, toCurrency: collectiveBalance.currency as SupportedCurrency };
        }),
      ),
    );

    const expenseIdsWithoutBalance = expensesWithoutPendingTaxForm
      .filter(expense => {
        const collectiveBalance = balances[expense.CollectiveId];
        const hasBalance =
          expense.amount * fxRates['latest'][expense.currency][collectiveBalance.currency] <= collectiveBalance.value;

        return !hasBalance;
      })
      .map(({ id }) => id);

    where[Op.and].push({ id: { [Op.notIn]: expenseIdsWithoutBalance } });
  }
};

export const ExpensesCollectionQueryArgs = {
  ...CollectionArgs,
  fromAccount: {
    type: GraphQLAccountReferenceInput,
    description: 'Reference of an account that is the payee of an expense',
  },
  fromAccounts: {
    type: new GraphQLList(GraphQLAccountReferenceInput),
    description: 'An alternative to filter by fromAccount (singular), both cannot be used together',
  },
  account: {
    type: GraphQLAccountReferenceInput,
    description: 'Reference of an account that is the payer of an expense',
  },
  accounts: {
    type: new GraphQLList(GraphQLAccountReferenceInput),
    description: 'An alternative to filter by accounts, both cannot be used together',
  },
  host: {
    type: GraphQLAccountReferenceInput,
    description: 'Return expenses only for this host',
  },
  hostContext: {
    type: GraphQLHostContext,
    description: 'If `host` is provided, select whether to include ALL, INTERNAL or HOSTED accounts expenses.',
  },
  createdByAccount: {
    type: GraphQLAccountReferenceInput,
    description: 'Return expenses only created by this INDIVIDUAL account',
  },
  status: {
    type: new GraphQLList(GraphQLExpenseStatusFilter),
    description: 'Use this field to filter expenses on their statuses',
  },
  type: {
    type: GraphQLExpenseType,
    description: 'Use this field to filter expenses on their type (RECEIPT/INVOICE)',
  },
  types: {
    type: new GraphQLList(GraphQLExpenseType),
  },
  tags: {
    type: new GraphQLList(GraphQLString),
    description: 'Only expenses that match these tags',
    deprecationReason: '2020-06-30: Please use tag (singular)',
  },
  tag: {
    type: new GraphQLList(GraphQLString),
    description: 'Only expenses that match these tags',
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
    description: 'Only return expenses where the amount is greater than or equal to this value (in cents)',
    deprecate: '2025-05-26: Please use amount instead',
  },
  maxAmount: {
    type: GraphQLInt,
    description: 'Only return expenses where the amount is lower than or equal to this value (in cents)',
    deprecate: '2025-05-26: Please use amount instead',
  },
  payoutMethodType: {
    type: GraphQLPayoutMethodType,
    description: 'Only return expenses that use the given type as payout method',
  },
  dateFrom: {
    type: GraphQLDateTime,
    description: 'Only return expenses that were created after this date',
  },
  dateTo: {
    type: GraphQLDateTime,
    description: 'Only return expenses that were created after this date',
  },
  searchTerm: {
    type: GraphQLString,
    description: 'The term to search',
  },
  includeChildrenExpenses: {
    type: new GraphQLNonNull(GraphQLBoolean),
    defaultValue: false,
    description: 'Whether to include expenses from children of the account (Events and Projects)',
  },
  customData: {
    type: GraphQLJSON,
    description:
      'Only return expenses that contains this custom data. Requires being an admin of the collective, payee or host.',
  },
  chargeHasReceipts: {
    type: GraphQLBoolean,
    description: 'Filter expenses of type charges based on presence of receipts',
  },
  virtualCards: {
    type: new GraphQLList(GraphQLVirtualCardReferenceInput),
    description: 'Filter expenses of type charges using these virtual cards',
  },
  lastCommentBy: {
    type: new GraphQLList(GraphQLLastCommentBy),
    description: 'Filter expenses by the last user-role who replied to them',
  },
  accountingCategory: {
    type: new GraphQLList(GraphQLString),
    description: 'Only return expenses that match these accounting categories',
  },
  payoutMethod: {
    type: GraphQLPayoutMethodReferenceInput,
    description: 'Only return transactions that are associated with this payout method',
  },
  activity: {
    description: 'Filter expenses by activities',
    type: new GraphQLInputObjectType({
      name: 'ExpenseActivityFilter',
      fields: () => ({
        individual: {
          type: GraphQLAccountReferenceInput,
          description: 'Activities triggered by this individual',
        },
        type: {
          type: new GraphQLList(new GraphQLNonNull(GraphQLActivityType)),
          description: 'The type(s) of activities to filter by',
        },
      }),
    }),
  },
};

const loadAllAccountsFromArgs = async (
  args,
  req,
): Promise<{
  fromAccounts: Collective[];
  accounts: Collective[];
  host: Collective;
  createdByAccount: Collective;
}> => {
  if (args.accounts && args.account) {
    throw new Error('accounts and account cannot be used together');
  }

  const fetchAccountParams = { loaders: req.loaders, throwIfMissing: true };
  const getAccountsPromise = async (): Promise<Collective[]> => {
    if (args.account) {
      return [await fetchAccountWithReference(args.account, fetchAccountParams)];
    } else if (args.accounts && args.accounts.length > 0) {
      return fetchAccountsWithReferences(args.accounts, fetchAccountParams);
    } else {
      return [];
    }
  };

  const getFromAccountPromise = async (): Promise<Collective[]> => {
    if (args.fromAccount) {
      return [await fetchAccountWithReference(args.fromAccount, fetchAccountParams)];
    } else if (args.fromAccounts && args.fromAccounts.length > 0) {
      return fetchAccountsWithReferences(args.fromAccounts, fetchAccountParams);
    } else {
      return [];
    }
  };

  const [accounts, fromAccounts, host, createdByAccount] = await Promise.all([
    getAccountsPromise(),
    getFromAccountPromise(),
    args.host && fetchAccountWithReference(args.host, fetchAccountParams),
    args.createdByAccount && fetchAccountWithReference(args.createdByAccount, fetchAccountParams),
  ]);

  return { fromAccounts, accounts, host, createdByAccount };
};

export const ExpensesCollectionQueryResolver = async (
  _: void,
  args: Record<string, any> & { amount?: AmountRangeInputType },
  req: express.Request,
): Promise<CollectionReturnType & { totalAmount?: any }> => {
  const where = { [Op.and]: [] };
  const include = [];

  // Check arguments
  if (args.limit > 1000 && !req.remoteUser?.isRoot()) {
    throw new Error('Cannot fetch more than 1,000 expenses at the same time, please adjust the limit');
  }

  // Load accounts
  const { fromAccounts, accounts, host, createdByAccount } = await loadAllAccountsFromArgs(args, req);

  if (fromAccounts.length > 0) {
    const fromAccountIds = fromAccounts.map(account => account.id);
    if (args.includeChildrenExpenses) {
      const childIds = await req.loaders.Collective.childrenIds.loadMany(fromAccountIds);
      fromAccountIds.push(...childIds.flat().filter(result => typeof result === 'number'));
    }
    where['FromCollectiveId'] = fromAccountIds;
  }
  if (accounts.length > 0) {
    if (host && accounts.some(account => account.HostCollectiveId !== host.id || !account.isActive)) {
      throw new Error('When filtering by both host and accounts, all accounts must be hosted by the same host');
    }

    // Validate accounts match the hostContext requirements
    if (host && args.hostContext) {
      accounts.forEach(account => {
        const isHostAccount = account.id === host.id;
        const isHostChildAccount = account.ParentCollectiveId === host.id;

        if (args.hostContext === 'INTERNAL' && !isHostAccount && !isHostChildAccount) {
          throw new Error(
            'When hostContext is INTERNAL, accounts must be the host account or its children (projects/events)',
          );
        } else if (args.hostContext === 'HOSTED' && (isHostAccount || isHostChildAccount)) {
          throw new Error('When hostContext is HOSTED, accounts cannot be the host account or its direct children');
        }
      });
    }

    const accountIds = accounts.map(account => account.id);
    if (args.includeChildrenExpenses) {
      const childIds = (await req.loaders.Collective.childrenIds.loadMany(accountIds)).filter(
        id => id instanceof Array,
      );
      accountIds.push(...childIds.flat());
    }
    where['CollectiveId'] = uniq(accountIds);
  }
  if (host) {
    // Either the expense has its `HostCollectiveId` set to the host (when its paid) or the collective is hosted by the host
    include.push({ association: 'collective', attributes: [], required: true });

    // Base condition: the expense belongs to an account hosted by this host
    where[Op.and].push({
      [Op.or]: [
        { HostCollectiveId: host.id },
        {
          HostCollectiveId: { [Op.is]: null },
          '$collective.HostCollectiveId$': host.id,
          '$collective.approvedAt$': { [Op.not]: null },
        },
      ],
    });

    // When specific accounts are provided, skip hostContext-based filtering (accounts are already validated above)
    // hostContext filtering only applies when no specific accounts are selected
    if (args.hostContext && accounts.length === 0) {
      if (args.hostContext === 'INTERNAL') {
        // Only expenses from the host account and its children (projects/events)
        where[Op.and].push({
          [Op.or]: [{ '$collective.id$': host.id }, { '$collective.ParentCollectiveId$': host.id }],
        });
      } else if (args.hostContext === 'HOSTED') {
        // Only expenses from hosted accounts, excluding the host account and its children
        where[Op.and].push({
          '$collective.id$': { [Op.ne]: host.id },
          [Op.or]: [
            { '$collective.ParentCollectiveId$': { [Op.is]: null } },
            { '$collective.ParentCollectiveId$': { [Op.ne]: host.id } },
          ],
        });
      }
    }
  }
  if (createdByAccount) {
    if (createdByAccount.type !== CollectiveType.USER) {
      throw new Error('createdByAccount only accepts individual accounts');
    } else if (createdByAccount.isIncognito) {
      return { nodes: [], offset: 0, limit: 0, totalCount: 0 }; // Incognito cannot create expenses yet
    }

    const user = await req.loaders.User.byCollectiveId.load(createdByAccount.id);
    if (!user) {
      throw new Error('User not found');
    }

    where['UserId'] = user.id;
  }

  const isHostAdmin = host && req.remoteUser?.isAdminOfCollective(host);

  // Add search filter
  // Not searching in items yet because one-to-many relationships with limits are broken in Sequelize. Could be fixed by https://github.com/sequelize/sequelize/issues/4376
  const searchTermConditions = buildSearchConditions(args.searchTerm, {
    idFields: ['id'],
    dataFields: ['data.transactionId', 'data.transfer.id', 'data.transaction_id', 'data.batchGroup.id', 'reference'],
    slugFields: ['$fromCollective.slug$', '$collective.slug$', '$User.collective.slug$'],
    textFields: ['$fromCollective.name$', '$collective.name$', '$User.collective.name$', 'description'],
    emailFields: isHostAdmin ? ['$User.email$'] : [],
    amountFields: ['amount'],
    stringArrayFields: ['tags'],
    stringArrayTransformFn: (str: string) => str.toLowerCase(), // expense tags are stored lowercase
  });

  if (searchTermConditions.length) {
    where[Op.or] = searchTermConditions;
    include.push(
      { association: 'fromCollective', attributes: [] },
      { association: 'collective', attributes: [] },
      { association: 'User', attributes: [], include: [{ association: 'collective', attributes: [] }] },
    );
  }

  if (!isEmpty(args.virtualCards)) {
    where[Op.and].push({
      [Op.or]: [{ type: { [Op.ne]: ExpenseType.CHARGE } }, { VirtualCardId: args.virtualCards.map(vc => vc.id) }],
    });
  }

  // Add filters
  if (args.type) {
    where['type'] = args.type;
  } else if (args.types && args.types.length > 0) {
    where['type'] = {
      [Op.in]: args.types,
    };
  }

  if (args.tag || args.tags) {
    where['tags'] = { [Op.contains]: args.tag || args.tags };
  } else if (args.tag === null || args.tags === null) {
    where['tags'] = { [Op.is]: null };
  }

  if (args.dateFrom) {
    where['createdAt'] = { [Op.gte]: args.dateFrom };
  }
  if (args.dateTo) {
    where['createdAt'] = where['createdAt'] || {};
    where['createdAt'][Op.lte] = args.dateTo;
  }

  if (args.payoutMethod) {
    const payoutMethod = await fetchPayoutMethodWithReference(args.payoutMethod);
    assert(payoutMethod, new NotFound('Requested payment method not found'));
    assert(
      req.remoteUser?.isAdmin(payoutMethod.CollectiveId),
      new Forbidden("You need to be an admin of the payment method's collective to access this resource"),
    );
    where['PayoutMethodId'] = payoutMethod.id;
  } else if (args.payoutMethodType === 'CREDIT_CARD') {
    where[Op.and].push({ VirtualCardId: { [Op.not]: null } });
  } else if (args.payoutMethodType) {
    include.push({
      association: 'PayoutMethod',
      attributes: [],
      required: args.payoutMethodType !== PayoutMethodTypes.OTHER,
      where: { type: args.payoutMethodType },
    });

    if (args.payoutMethodType === PayoutMethodTypes.OTHER) {
      where[Op.and].push(sequelize.literal(`("PayoutMethodId" IS NULL OR "PayoutMethod".type = 'OTHER')`));
    }
  }

  /*
   * Please notice that updateFilterConditionsForReadyToPay will query the DB with existing conditionals,
   * for performance reasons, we should make sure that complex conditionals are added after this function is called.
   */
  if (args.status && args.status.length > 0) {
    if (args.status.includes('ON_HOLD') && args.status.length === 1) {
      where['onHold'] = true;
    } else if (args.status.includes('READY_TO_PAY')) {
      assert(args.status.length === 1, 'READY_TO_PAY cannot be combined with other statuses');
      await updateFilterConditionsForReadyToPay(where, include, host, req.loaders);
    } else {
      where['status'] = args.status;
      if (!args.status.includes('ON_HOLD')) {
        where['onHold'] = false;
      }
    }
  } else {
    if (req.remoteUser) {
      const userClause: any[] = [{ status: { [Op.notIn]: [expenseStatus.DRAFT, expenseStatus.SPAM] } }];

      if (accounts.every(account => req.remoteUser.isAdminOfCollectiveOrHost(account))) {
        userClause.push({ status: expenseStatus.DRAFT });
      } else {
        userClause.push({ status: expenseStatus.DRAFT, UserId: req.remoteUser.id });
      }

      where[Op.and].push({ [Op.or]: userClause });
    } else {
      where['status'] = { [Op.notIn]: [expenseStatus.DRAFT, expenseStatus.SPAM] };
    }
  }

  if (!isNil(args.chargeHasReceipts)) {
    where[Op.and].push(
      { type: ExpenseType.CHARGE },
      sequelize.where(
        sequelize.literal(
          `NOT EXISTS (SELECT id from "ExpenseItems" ei WHERE ei."ExpenseId" = "Expense".id and ei.url IS NULL AND ei."deletedAt" IS NULL)`,
        ),
        Op.eq,
        args.chargeHasReceipts,
      ),
    );
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

    where[Op.and].push(
      sequelize.where(
        sequelize.literal(
          SequelizeUtils.formatNamedParameters(
            `
            CASE
              WHEN "Expense".currency = :currency THEN 1.0
              WHEN "Expense"."data" #>> '{quote,sourceCurrency}' = :currency
                AND "Expense"."data" #>> '{quote,targetCurrency}' = "Expense"."currency"
                THEN 1.0 / ("Expense"."data" #> '{quote,rate}')::NUMERIC
              WHEN "Expense"."data" #>> '{quote,sourceCurrency}' = "Expense"."currency"
                AND "Expense"."data" #>> '{quote,targetCurrency}' = :currency
                THEN ("Expense"."data" #> '{quote,rate}')::NUMERIC
              ELSE COALESCE(
                (SELECT rate FROM "CurrencyExchangeRates"
                  WHERE "from" = "Expense"."currency"
                  AND "to" = :currency
                  -- Most recent rate that is older than the expense, thanks to the combination of "<=" + ORDER BY DESC + LIMIT 1
                  AND "createdAt" <= COALESCE("Expense"."incurredAt", "Expense"."createdAt")
                  ORDER BY "createdAt" DESC
                  LIMIT 1),
                1
              )
            END * "Expense"."amount" 
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
      where['amount'] = { [Op.gte]: args.minAmount };
    }
    if (args.maxAmount) {
      where['amount'] = { ...where['amount'], [Op.lte]: args.maxAmount };
    }
  }

  if (args.lastCommentBy?.length) {
    assert(
      host && req.remoteUser.hasRole([MemberRoles.HOST, MemberRoles.ADMIN, MemberRoles.ACCOUNTANT], host.id),
      'You need to be an admin of the host to filter by lastCommentBy',
    );
    const conditions = [];
    const CollectiveIds = compact([
      args.lastCommentBy.includes('COLLECTIVE_ADMIN') && '"Expense"."CollectiveId"',
      args.lastCommentBy.includes('HOST_ADMIN') && `"collective"."HostCollectiveId"`,
    ]);

    // Collective Conditions
    if (CollectiveIds.length) {
      conditions.push(
        sequelize.literal(
          `(SELECT "FromCollectiveId" FROM "Comments" WHERE "Comments"."deletedAt" IS NULL AND "Comments"."ExpenseId" = "Expense"."id" ORDER BY "id" DESC LIMIT 1)
            IN (
              SELECT "MemberCollectiveId" FROM "Members" WHERE
              "role" = 'ADMIN' AND "deletedAt" IS NULL AND
              "CollectiveId" IN (${CollectiveIds.join(',')})
          )`,
        ),
      );
    }
    // User Condition
    if (args.lastCommentBy.includes('USER')) {
      conditions.push(
        sequelize.literal(
          `(SELECT "CreatedByUserId" FROM "Comments" WHERE "Comments"."deletedAt" IS NULL AND "Comments"."ExpenseId" = "Expense"."id" ORDER BY "id" DESC LIMIT 1) = "Expense"."UserId"`,
        ),
      );
    }

    if (args.lastCommentBy.includes('NON_HOST_ADMIN')) {
      conditions.push(
        sequelize.literal(
          `(SELECT "FromCollectiveId" FROM "Comments" WHERE "Comments"."deletedAt" IS NULL AND "Comments"."ExpenseId" = "Expense"."id" ORDER BY "id" DESC LIMIT 1)
            NOT IN (
              SELECT "MemberCollectiveId" FROM "Members" WHERE
              "role" = 'ADMIN' AND "deletedAt" IS NULL AND
              "CollectiveId" = "collective"."HostCollectiveId"
          )`,
        ),
      );
    }

    where[Op.and].push(conditions.length > 1 ? { [Op.or]: conditions } : conditions[0]);
  }

  if (args.customData) {
    // Check permissions
    if (!req.remoteUser) {
      throw new Unauthorized('You need to be logged in to filter by customData');
    } else if (!fromAccounts.length && !accounts.length && !host) {
      throw new Unauthorized(
        'You need to filter by at least one of fromAccount, account or host to filter by customData',
      );
    } else if (
      (host && !req.remoteUser.isAdminOfCollectiveOrHost(host)) ||
      (fromAccounts.length && !fromAccounts.every(account => req.remoteUser.isAdminOfCollectiveOrHost(account))) ||
      (accounts.length && !accounts.every(account => req.remoteUser.isAdminOfCollectiveOrHost(account)))
    ) {
      throw new Unauthorized('You need to be an admin of the fromAccount, account or host to filter by customData');
    }

    validateExpenseCustomData(args.customData); // To ensure we don't get an invalid type or too long string
    where['data'] = { [Op.contains]: { customData: args.customData } };
  }

  if (!isEmpty(args.accountingCategory)) {
    const conditionals = uniq(args.accountingCategory).map(code => [
      { '$accountingCategory.code$': code === UncategorizedValue ? null : code },
    ]);
    where[Op.and].push({ [Op.or]: conditionals });
    include.push({ model: AccountingCategory, as: 'accountingCategory' });
  }

  if (args.activity) {
    const activitiesConditions: WhereOptions<Activity> = {};
    if (args.activity.individual) {
      const account = await fetchAccountWithReference(args.activity.individual, { throwIfMissing: true });
      const user = await req.loaders.User.byCollectiveId.load(account.id);
      if (!user) {
        throw new NotFound('User not found');
      }
      activitiesConditions.UserId = user.id;
    }
    if (args.activity.type && args.activity.type.length > 0) {
      const allowedActivityTypes = new Set([
        ActivityTypes.COLLECTIVE_EXPENSE_CREATED,
        ActivityTypes.COLLECTIVE_EXPENSE_DELETED,
        ActivityTypes.COLLECTIVE_EXPENSE_UPDATED,
        ActivityTypes.COLLECTIVE_EXPENSE_REJECTED,
        ActivityTypes.COLLECTIVE_EXPENSE_APPROVED,
        ActivityTypes.COLLECTIVE_EXPENSE_RE_APPROVAL_REQUESTED,
        ActivityTypes.COLLECTIVE_EXPENSE_UNAPPROVED,
        ActivityTypes.COLLECTIVE_EXPENSE_MOVED,
        ActivityTypes.COLLECTIVE_EXPENSE_PAID,
        ActivityTypes.COLLECTIVE_EXPENSE_MARKED_AS_UNPAID,
        ActivityTypes.COLLECTIVE_EXPENSE_MARKED_AS_SPAM,
        ActivityTypes.COLLECTIVE_EXPENSE_MARKED_AS_INCOMPLETE,
        ActivityTypes.COLLECTIVE_EXPENSE_PUT_ON_HOLD,
        ActivityTypes.COLLECTIVE_EXPENSE_RELEASED_FROM_HOLD,
        ActivityTypes.COLLECTIVE_EXPENSE_SCHEDULED_FOR_PAYMENT,
        ActivityTypes.COLLECTIVE_EXPENSE_UNSCHEDULED_FOR_PAYMENT,
        ActivityTypes.COLLECTIVE_EXPENSE_ERROR,
        ActivityTypes.COLLECTIVE_EXPENSE_INVITE_DRAFTED,
        ActivityTypes.COLLECTIVE_EXPENSE_INVITE_DECLINED,
        ActivityTypes.COLLECTIVE_EXPENSE_RECURRING_DRAFTED,
        ActivityTypes.COLLECTIVE_EXPENSE_MISSING_RECEIPT,
      ]);

      const invalidActivityTypes = args.activity.type.filter(type => !allowedActivityTypes.has(type));
      if (invalidActivityTypes.length > 0) {
        throw new Forbidden(`Invalid activity type: ${invalidActivityTypes.join(', ')}`);
      }

      activitiesConditions.type = { [Op.in]: args.activity.type };
    }

    include.push({ association: 'activities', required: true, attributes: [], where: activitiesConditions });
  }

  const order = [[args.orderBy.field, args.orderBy.direction]] as OrderItem[];

  const { offset, limit } = args;

  const fetchNodes = () => {
    return Expense.findAll({ include, where, order, offset, limit });
  };

  const fetchTotalCount = () => {
    return Expense.count({ include, where });
  };

  return {
    nodes: fetchNodes,
    totalCount: fetchTotalCount,
    totalAmount: async () => {
      const query = (await Expense.findAll({
        attributes: [
          [Sequelize.col('"Expense"."currency"'), 'expenseCurrency'],
          [Sequelize.fn('SUM', Sequelize.col('amount')), 'amount'],
        ],
        group: 'expenseCurrency',
        include,
        where,
        raw: true,
      })) as unknown as { expenseCurrency: string; amount: number }[];

      const amountsByCurrency = query.map(result => ({ currency: result.expenseCurrency, value: result.amount }));

      return {
        amountsByCurrency,
        amount: async ({ currency = 'USD' }) => {
          const values = await req.loaders.CurrencyExchangeRate.convert.loadMany(
            amountsByCurrency.map(v => ({
              amount: v.value,
              fromCurrency: v.currency as SupportedCurrency,
              toCurrency: currency as SupportedCurrency,
            })),
          );
          return {
            value: sum(values),
            currency,
          };
        },
      };
    },
    limit: args.limit,
    offset: args.offset,
  };
};

const ExpensesCollectionQuery = {
  type: new GraphQLNonNull(GraphQLExpenseCollection),
  args: ExpensesCollectionQueryArgs,
  resolve: ExpensesCollectionQueryResolver,
};

export default ExpensesCollectionQuery;
