import express from 'express';
import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLDateTime, GraphQLJSON } from 'graphql-scalars';
import { isEmpty, isNil, uniq } from 'lodash';
import { OrderItem } from 'sequelize';

import { expenseStatus } from '../../../../constants';
import { CollectiveType } from '../../../../constants/collectives';
import { getBalances } from '../../../../lib/budget';
import { buildSearchConditions } from '../../../../lib/search';
import { expenseMightBeSubjectToTaxForm } from '../../../../lib/tax-forms';
import models, { Op, sequelize } from '../../../../models';
import { ExpenseType } from '../../../../models/Expense';
import { PayoutMethodTypes } from '../../../../models/PayoutMethod';
import { validateExpenseCustomData } from '../../../common/expenses';
import { Unauthorized } from '../../../errors';
import { loadFxRatesMap } from '../../../loaders/currency-exchange-rate';
import { GraphQLExpenseCollection } from '../../collection/ExpenseCollection';
import GraphQLExpenseStatusFilter from '../../enum/ExpenseStatusFilter';
import { GraphQLExpenseType } from '../../enum/ExpenseType';
import { GraphQLPayoutMethodType } from '../../enum/PayoutMethodType';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../../input/AccountReferenceInput';
import {
  CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE,
  GraphQLChronologicalOrderInput,
} from '../../input/ChronologicalOrderInput';
import { GraphQLVirtualCardReferenceInput } from '../../input/VirtualCardReferenceInput';
import { CollectionArgs, CollectionReturnType } from '../../interface/Collection';

const updateFilterConditionsForReadyToPay = async (where, include, host, loaders): Promise<void> => {
  where['status'] = expenseStatus.APPROVED;
  where['onHold'] = false;

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

export const ExpensesCollectionQueryArgs = {
  ...CollectionArgs,
  fromAccount: {
    type: GraphQLAccountReferenceInput,
    description: 'Reference of an account that is the payee of an expense',
  },
  account: {
    type: GraphQLAccountReferenceInput,
    description: 'Reference of an account that is the payer of an expense',
  },
  host: {
    type: GraphQLAccountReferenceInput,
    description: 'Return expenses only for this host',
  },
  createdByAccount: {
    type: GraphQLAccountReferenceInput,
    description: 'Return expenses only created by this INDIVIDUAL account',
  },
  status: {
    type: GraphQLExpenseStatusFilter,
    description: 'Use this field to filter expenses on their statuses',
  },
  type: {
    type: GraphQLExpenseType,
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
    type: new GraphQLNonNull(GraphQLChronologicalOrderInput),
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
};

export const ExpensesCollectionQueryResolver = async (
  _: void,
  args,
  req: express.Request,
): Promise<CollectionReturnType> => {
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

  const isHostAdmin = host && req.remoteUser?.isAdminOfCollective(host);

  // Add search filter
  // Not searching in items yet because one-to-many relationships with limits are broken in Sequelize. Could be fixed by https://github.com/sequelize/sequelize/issues/4376
  const searchTermConditions = buildSearchConditions(args.searchTerm, {
    idFields: ['id'],
    dataFields: ['data.transactionId', 'data.transfer.id', 'data.transaction_id', 'data.batchGroup.id'],
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

  if (!isNil(args.chargeHasReceipts)) {
    where[Op.and].push({
      [Op.or]: [
        { type: { [Op.ne]: ExpenseType.CHARGE } },
        sequelize.where(
          sequelize.literal(`
                 NOT EXISTS (SELECT id from "ExpenseItems" ei where ei."ExpenseId" = "Expense".id and ei.url IS NULL)`),
          Op.eq,
          args.chargeHasReceipts,
        ),
      ],
    });
  }

  if (!isEmpty(args.virtualCards)) {
    where[Op.and].push({
      [Op.or]: [{ type: { [Op.ne]: ExpenseType.CHARGE } }, { VirtualCardId: args.virtualCards.map(vc => vc.id) }],
    });
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
    if (args.status === 'ON_HOLD') {
      where['onHold'] = true;
    } else if (args.status !== 'READY_TO_PAY') {
      where['status'] = args.status;
    } else {
      await updateFilterConditionsForReadyToPay(where, include, host, req.loaders);
    }
  } else {
    if (req.remoteUser) {
      const userClause: any[] = [{ status: { [Op.notIn]: [expenseStatus.DRAFT, expenseStatus.SPAM] } }];

      if (req.remoteUser.isAdminOfCollectiveOrHost(account)) {
        userClause.push({ status: expenseStatus.DRAFT });
      } else {
        userClause.push({ status: expenseStatus.DRAFT, UserId: req.remoteUser.id });
      }

      where[Op.and].push({ [Op.or]: userClause });
    } else {
      where['status'] = { [Op.notIn]: [expenseStatus.DRAFT, expenseStatus.SPAM] };
    }
  }

  if (args.customData) {
    // Check permissions
    if (!req.remoteUser) {
      throw new Unauthorized('You need to be logged in to filter by customData');
    } else if (!fromAccount && !account && !host) {
      throw new Unauthorized(
        'You need to filter by at least one of fromAccount, account or host to filter by customData',
      );
    } else if (
      !(fromAccount && req.remoteUser.isAdminOfCollective(fromAccount)) &&
      !(account && req.remoteUser.isAdminOfCollective(account)) &&
      !(host && req.remoteUser.isAdmin(host))
    ) {
      throw new Unauthorized('You need to be an admin of the fromAccount, account or host to filter by customData');
    }

    validateExpenseCustomData(args.customData); // To ensure we don't get an invalid type or too long string
    where['data'] = { [Op.contains]: { customData: args.customData } };
  }

  const order = [[args.orderBy.field, args.orderBy.direction]] as OrderItem[];
  const { offset, limit } = args;
  const result = await models.Expense.findAndCountAll({ include, where, order, offset, limit });
  return {
    nodes: result.rows,
    totalCount: result.count,
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
