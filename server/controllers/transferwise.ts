import { NextFunction, Request, Response } from 'express';
import { pick, uniq } from 'lodash';

import expenseStatus from '../constants/expense_status';
import {
  createTransferWiseTransactionsAndUpdateExpense,
  getExpenseFeesInHostCurrency,
} from '../graphql/common/expenses';
import { idDecode, IDENTIFIER_TYPES } from '../graphql/v2/identifiers';
import errors from '../lib/errors';
import models, { Op } from '../models';
import transferwise from '../paymentProviders/transferwise';

const processPaidExpense = (host, remoteUser, fundData) => async expense => {
  const payoutMethod = await expense.getPayoutMethod();
  const { feesInHostCurrency } = await getExpenseFeesInHostCurrency({
    host,
    expense,
    payoutMethod,
    fees: {},
    forceManual: false,
  });
  return createTransferWiseTransactionsAndUpdateExpense({
    host,
    expense,
    data: { ...pick(expense.data, ['transfer']), fundData },
    fees: feesInHostCurrency,
    remoteUser,
  });
};

export async function payBatch(
  req: Request<any, any, { expenseIds: Array<string>; hostId: string }>,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { remoteUser, headers, body } = req;
    if (!remoteUser) {
      throw new errors.Unauthorized('User needs to be logged in');
    }

    const host = await models.Collective.findByPk(idDecode(body.hostId, IDENTIFIER_TYPES.ACCOUNT));
    if (!host) {
      throw new errors.NotFound('Could not find host collective');
    }
    if (!remoteUser.isAdmin(host.id)) {
      throw new errors.Unauthorized('User must be admin of host collective');
    }
    // TODO: ensure expense ids are sent with the OTT retry request
    const expenseIds = body?.expenseIds?.map(id => idDecode(id, IDENTIFIER_TYPES.EXPENSE));
    const expenses = await models.Expense.findAll({
      where: { id: { [Op.in]: expenseIds } },
      include: [{ model: models.PayoutMethod, as: 'PayoutMethod' }],
    });

    if (expenseIds.length !== expenses.length) {
      throw new errors.NotFound('Could not find every expense requested');
    }
    const ottHeader = headers['x-2fa-approval'] as string;

    if (ottHeader) {
      const fundResponse = await transferwise.fundExpensesBatchGroup(host, undefined, ottHeader);
      await Promise.all(expenses.map(processPaidExpense(host, remoteUser, fundResponse)));
    } else {
      expenses.forEach(expense => {
        if (expense.currency !== host.currency) {
          throw new Error('Can not batch expenses with different currencies');
        }
        if (expense.status !== expenseStatus.SCHEDULED_FOR_PAYMENT) {
          throw new Error('Expense must be scheduled for payment');
        }
      });

      const collectiveIds = uniq(expenses.map(e => e.CollectiveId));
      const collectives = await models.Collective.findAll({ where: { id: { [Op.in]: collectiveIds } } });
      const hostIds = uniq(collectives.map(c => c.HostCollectiveId));
      if (hostIds.length !== 1 || hostIds[0] !== host.id) {
        throw new errors.BadRequest('Expenses must belong to the requested host');
      }

      const batchGroup = await transferwise.createExpensesBatchGroup(host, expenses);
      const fundResponse = await transferwise.fundExpensesBatchGroup(host, batchGroup);
      // If OTT response, proxy it to the frontend and return early
      if ('status' in fundResponse && 'headers' in fundResponse) {
        res.setHeader('x-2fa-approval', fundResponse.headers['x-2fa-approval']);
        res.sendStatus(fundResponse.status);
        return;
      }
      // Else, mark expenses as paid and create transactions
      await Promise.all(expenses.map(processPaidExpense(host, remoteUser, fundResponse)));
    }

    // Send 200 if everything is fine and dandy
    res.sendStatus(200);
  } catch (e) {
    next(e);
  }
}
