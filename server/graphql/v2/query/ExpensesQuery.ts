import express from 'express';
import { GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { isEmpty, partition } from 'lodash';

import { expenseStatus } from '../../../constants';
import EXPENSE_TYPE from '../../../constants/expense_type';
import { US_TAX_FORM_THRESHOLD } from '../../../constants/tax-form';
import { getBalancesWithBlockedFunds } from '../../../lib/budget';
import queries from '../../../lib/queries';
import models, { Op, sequelize } from '../../../models';
import { PayoutMethodTypes } from '../../../models/PayoutMethod';
import { ExpenseCollection } from '../collection/ExpenseCollection';
import ExpenseStatusFilter from '../enum/ExpenseStatusFilter';
import { ExpenseType } from '../enum/ExpenseType';
import PayoutMethodType from '../enum/PayoutMethodType';
import { AccountReferenceInput, fetchAccountWithReference } from '../input/AccountReferenceInput';
import { CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE, ChronologicalOrderInput } from '../input/ChronologicalOrderInput';
import { CollectionArgs, CollectionReturnType } from '../interface/Collection';
import ISODateTime from '../scalar/ISODateTime';

const updateFilterConditionsForReadyToPay = async (where, include): Promise<void> => {
  where['status'] = expenseStatus.APPROVED;

  // Get all collectives matching the search that have APPROVED expenses
  const results = await models.Expense.findAll({
    where,
    include,
    attributes: ['Expense.id', 'FromCollectiveId', 'CollectiveId'],
    group: ['Expense.id', 'Expense.FromCollectiveId', 'Expense.CollectiveId'],
    raw: true,
  });

  const [expensesSubjectToTaxForm, expensesWithoutTaxForm] = partition(results, e => e.type !== EXPENSE_TYPE.RECEIPT);

  // Check the balances for these collectives. The following will emit an SQL like:
  // AND ((CollectiveId = 1 AND amount < 5000) OR (CollectiveId = 2 AND amount < 3000))
  if (!isEmpty(results)) {
    // TODO: move to new balance calculation v2 when possible
    const balances = await getBalancesWithBlockedFunds(results.map(e => e.CollectiveId));
    where[Op.and].push({
      [Op.or]: Object.values(balances).map(({ CollectiveId, value }) => ({
        CollectiveId,
        amount: { [Op.lte]: value },
      })),
    });
  }

  // Check tax forms
  const taxFormConditions = [];
  if (expensesSubjectToTaxForm.length > 0) {
    const taxFormResults = await queries.getTaxFormsRequiredForExpenses(results.map(e => e.id));
    const expensesWithPendingTaxForm = [];

    taxFormResults.forEach(result => {
      if (
        result.requiredDocument &&
        result.total >= US_TAX_FORM_THRESHOLD &&
        result.legalDocRequestStatus !== models.LegalDocument.requestStatus.RECEIVED
      ) {
        expensesWithPendingTaxForm.push(result.expenseId);
      }
    });

    taxFormConditions.push({ id: { [Op.notIn]: expensesWithPendingTaxForm } });
  }

  if (taxFormConditions.length) {
    if (expensesWithoutTaxForm.length) {
      const ignoredIds = expensesWithoutTaxForm.map(e => e.id);
      where[Op.and].push({ [Op.or]: [{ id: { [Op.in]: ignoredIds } }, { [Op.and]: taxFormConditions }] });
    } else {
      where[Op.and].push(...taxFormConditions);
    }
  }
};

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
    host: {
      type: AccountReferenceInput,
      description: 'Return expenses only for this host',
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
    },
    orderBy: {
      type: new GraphQLNonNull(ChronologicalOrderInput),
      description: 'The order of results',
      defaultValue: CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE,
    },

  },
  async resolve(_: void, args, req: express.Request): Promise<CollectionReturnType> {
    const where = { [Op.and]: [] };
    const include = [];

    // Check arguments
    if (args.limit > 100) {
      throw new Error('Cannot fetch more than 100 expenses at the same time, please adjust the limit');
    }

    // Load accounts
    const fetchAccountParams = { loaders: req.loaders, throwIfMissing: true };
    const [fromAccount, account, host] = await Promise.all(
      [args.fromAccount, args.account, args.host].map(
        reference => reference && fetchAccountWithReference(reference, fetchAccountParams),
      ),
    );

    if (fromAccount) {
      where['FromCollectiveId'] = fromAccount.id;
    }
    if (account) {
      where['CollectiveId'] = account.id;
    }
    if (host) {
      include.push({
        association: 'collective',
        attributes: [],
        required: true,
        where: { HostCollectiveId: host.id, approvedAt: { [Op.not]: null } },
      });
    }

    // Add search filter

    }

    // Add filters
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
        where[Op.and].push(sequelize.literal(`("PayoutMethodId" IS NULL OR "PayoutMethod".type = 'OTHER')`));
      }
    }

    if (args.status) {
      if (args.status !== 'READY_TO_PAY') {
        where['status'] = args.status;
      } else {
        await updateFilterConditionsForReadyToPay(where, include);
      }
    } else {
      if (req.remoteUser) {
        where[Op.and].push({
          [Op.or]: [
            { status: { [Op.notIn]: [expenseStatus.DRAFT, expenseStatus.SPAM] } },
            { status: expenseStatus.DRAFT, UserId: req.remoteUser.id },
            // TODO: we should ideally display SPAM expenses in some circumstances
          ],
        });
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

export default ExpensesQuery;
