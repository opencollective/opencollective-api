import express from 'express';
import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import { isEmpty, uniq } from 'lodash';

import { expenseStatus } from '../../../../constants';
import { types as CollectiveType } from '../../../../constants/collectives';
import { TAX_FORM_IGNORED_EXPENSE_TYPES } from '../../../../constants/tax-form';
import { getBalances } from '../../../../lib/budget';
import queries from '../../../../lib/queries';
import { buildSearchConditions } from '../../../../lib/search';
import models, { Op, sequelize } from '../../../../models';
import { PayoutMethodTypes } from '../../../../models/PayoutMethod';
import { loadFxRatesMap } from '../../../loaders/currency-exchange-rate';
import { ExpenseCollection } from '../../collection/ExpenseCollection';
import ExpenseStatusFilter from '../../enum/ExpenseStatusFilter';
import { ExpenseType } from '../../enum/ExpenseType';
import { PayoutMethodType } from '../../enum/PayoutMethodType';
import { AccountReferenceInput, fetchAccountWithReference } from '../../input/AccountReferenceInput';
import { CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE, ChronologicalOrderInput } from '../../input/ChronologicalOrderInput';
import { CollectionArgs, CollectionReturnType } from '../../interface/Collection';

const updateFilterConditionsForReadyToPay = async (where, include, host): Promise<void> => {
  where['status'] = expenseStatus.APPROVED;

  // Get all collectives matching the search that have APPROVED expenses
  const expenses = await models.Expense.findAll({
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
  let expensesIdsPendingTaxForms = new Set();
  let checkTaxForms = true;

  // No need to trigger the full query if the host doesn't have any tax forms requirement
  if (host) {
    const legalDocsCount = await host.countRequiredLegalDocuments({ where: { documentType: 'US_TAX_FORM' } });
    checkTaxForms = legalDocsCount > 0;
  }

  if (checkTaxForms) {
    const expensesSubjectToTaxForm = expenses.filter(e => !TAX_FORM_IGNORED_EXPENSE_TYPES.includes(e.type));
    if (expensesSubjectToTaxForm.length > 0) {
      const expensesIdsSubjectToTaxForm = expensesSubjectToTaxForm.map(expense => expense.id);
      expensesIdsPendingTaxForms = await queries.getTaxFormsRequiredForExpenses(expensesIdsSubjectToTaxForm);
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
          return { fromCurrency: expense.currency, toCurrency: collectiveBalance.currency };
        }),
      ),
    );

    const expenseIdsWithoutBalance = expensesWithoutPendingTaxForm
      .filter(expense => {
        const collectiveBalance = balances[expense.CollectiveId];
        const hasBalance =
          expense.amount * fxRates[expense.currency][collectiveBalance.currency] <= collectiveBalance.value;
        return !hasBalance;
      })
      .map(({ id }) => id);

    where[Op.and].push({ id: { [Op.notIn]: expenseIdsWithoutBalance } });
  }
};

const ExpensesCollectionQuery = {
  type: new GraphQLNonNull(ExpenseCollection),
  args: {
    ...CollectionArgs,
    fromAccount: {
      type: AccountReferenceInput,
      description: 'Reference of an account that is the payee of an expense',
    },
    account: {
      type: AccountReferenceInput,
      description: 'Reference of an account that is the payer of an expense',
    },
    host: {
      type: AccountReferenceInput,
      description: 'Return expenses only for this host',
    },
    createdByAccount: {
      type: AccountReferenceInput,
      description: 'Return expenses only created by this INDIVIDUAL account',
    },
    status: {
      type: ExpenseStatusFilter,
      description: 'Use this field to filter expenses on their statuses',
    },
    type: {
      type: ExpenseType,
      description: 'Use this field to filter expenses on their type (RECEIPT/INVOICE)',
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
  },
  async resolve(_: void, args, req: express.Request): Promise<CollectionReturnType> {
    const where = { [Op.and]: [] };
    const include = [];

    // Check arguments
    if (args.limit > 1000 && !req.remoteUser?.isRoot()) {
      throw new Error('Cannot fetch more than 1,000 expenses at the same time, please adjust the limit');
    }

    // Load accounts
    const fetchAccountParams = { loaders: req.loaders, throwIfMissing: true };
    const [fromAccount, account, host, createdByAccount] = await Promise.all(
      [args.fromAccount, args.account, args.host, args.createdByAccount].map(
        reference => reference && fetchAccountWithReference(reference, fetchAccountParams),
      ),
    );
    if (fromAccount) {
      const fromAccounts = [fromAccount.id];
      if (args.includeChildrenExpenses) {
        const childIds = await fromAccount.getChildren().then(children => children.map(child => child.id));
        fromAccounts.push(...childIds);
      }
      where['FromCollectiveId'] = fromAccounts;
    }
    if (account) {
      const accounts = [account.id];
      if (args.includeChildrenExpenses) {
        const childIds = await account.getChildren().then(children => children.map(child => child.id));
        accounts.push(...childIds);
      }
      where['CollectiveId'] = accounts;
    }
    if (host) {
      include.push({
        association: 'collective',
        attributes: [],
        required: true,
        where: { HostCollectiveId: host.id, approvedAt: { [Op.not]: null } },
      });
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

    // Add search filter
    // Not searching in items yet because one-to-many relationships with limits are broken in Sequelize. Could be fixed by https://github.com/sequelize/sequelize/issues/4376
    const searchTermConditions = buildSearchConditions(args.searchTerm, {
      idFields: ['id'],
      slugFields: ['$fromCollective.slug$', '$User.collective.slug$'],
      textFields: ['$fromCollective.name$', '$User.collective.name$', 'description'],
      amountFields: ['amount'],
      stringArrayFields: ['tags'],
      stringArrayTransformFn: (str: string) => str.toLowerCase(), // expense tags are stored lowercase
    });

    if (searchTermConditions.length) {
      where[Op.or] = searchTermConditions;
      include.push(
        { association: 'fromCollective', attributes: [] },
        { association: 'User', attributes: [], include: [{ association: 'collective', attributes: [] }] },
      );
    }

    // Add filters
    if (args.type) {
      where['type'] = args.type;
    }
    if (args.tag || args.tags) {
      where['tags'] = { [Op.contains]: args.tag || args.tags };
    } else if (args.tag === null || args.tags === null) {
      where['tags'] = { [Op.is]: null };
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
    if (args.dateTo) {
      where['createdAt'] = where['createdAt'] || {};
      where['createdAt'][Op.lte] = args.dateTo;
    }

    if (args.payoutMethodType === 'CREDIT_CARD') {
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

    if (args.status) {
      if (args.status !== 'READY_TO_PAY') {
        where['status'] = args.status;
      } else {
        await updateFilterConditionsForReadyToPay(where, include, host);
      }
    } else {
      if (req.remoteUser) {
        const userClause: any[] = [{ status: { [Op.notIn]: [expenseStatus.DRAFT, expenseStatus.SPAM] } }];

        if (req.remoteUser.isAdminOfCollective(account)) {
          userClause.push({ status: expenseStatus.DRAFT });
        } else {
          userClause.push({ status: expenseStatus.DRAFT, UserId: req.remoteUser.id });
        }

        where[Op.and].push({ [Op.or]: userClause });
      } else {
        where['status'] = { [Op.notIn]: [expenseStatus.DRAFT, expenseStatus.SPAM] };
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

export default ExpensesCollectionQuery;
