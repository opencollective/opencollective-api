import config from 'config';
import { Request, Response } from 'express';

import expenseStatus from '../constants/expense-status';
import { getExpenseFees, setTransferWiseExpenseAsProcessing } from '../graphql/common/expenses';
import { idDecode, IDENTIFIER_TYPES } from '../graphql/v2/identifiers';
import errors from '../lib/errors';
import logger from '../lib/logger';
import { reportErrorToSentry, reportMessageToSentry } from '../lib/sentry';
import { simulateTransferSuccess } from '../lib/transferwise';
import models, { Op } from '../models';
import transferwise from '../paymentProviders/transferwise';
import { handleTransferStateChange } from '../paymentProviders/transferwise/webhook';
import { BatchGroup } from '../types/transferwise';

const processPaidExpense = (host, remoteUser, batchGroup: BatchGroup) => async expense => {
  try {
    await expense.reload();
    if (expense.data?.transfer) {
      const payoutMethod = await expense.getPayoutMethod();
      const { feesInHostCurrency } = await getExpenseFees(expense, host, { payoutMethod });
      return setTransferWiseExpenseAsProcessing({
        expense,
        host,
        data: { batchGroup },
        feesInHostCurrency,
        remoteUser,
      });
    }
  } catch (e) {
    logger.error(`Wise Batch Payment: Error processing paid expense ${expense.id}`, e);
  }
};

export async function payBatch(
  req: Request<any, any, { expenseIds: Array<string>; hostId: string }>,
  res: Response,
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
    const expenseIds = body.expenseIds?.map(id => idDecode(id, IDENTIFIER_TYPES.EXPENSE));
    const expenses = await models.Expense.findAll({
      where: { id: { [Op.in]: expenseIds } },
      include: [
        { model: models.PayoutMethod, as: 'PayoutMethod', required: true },
        {
          model: models.Collective,
          as: 'collective',
          attributes: [],
          // TODO: We should ideally use the host attached to the expense. See https://github.com/opencollective/opencollective/issues/4271
          where: { HostCollectiveId: host.id },
          required: true,
        },
      ],
    });

    expenses.forEach(expense => {
      if (expense.status !== expenseStatus.SCHEDULED_FOR_PAYMENT) {
        throw new Error(`Expense ${expense.id} must be scheduled for payment`);
      }
    });

    if (expenseIds.length !== expenses.length) {
      const errorInfo = { requested: expenseIds, found: expenses.map(e => e.id) };
      logger.error(`Wise Batch Pay: Could not find all requested expenses. ${JSON.stringify(errorInfo)}`);
      reportMessageToSentry('Wise Batch Pay: Could not find all requested expenses', { extra: errorInfo });
      throw new errors.NotFound('Could not find requested expenses');
    }
    const ottHeader = headers['x-2fa-approval'] as string;

    const fundResponse = ottHeader
      ? // Forward OTT response if included
        await transferwise.payExpensesBatchGroup(host, undefined, ottHeader, remoteUser)
      : // Otherwise, send the list of Expenses to pay the batch
        await transferwise.payExpensesBatchGroup(host, expenses, undefined, remoteUser);

    // If OTT response, proxy it to the frontend and return early
    if ('status' in fundResponse && 'headers' in fundResponse) {
      res.setHeader('x-2fa-approval', fundResponse.headers['x-2fa-approval']);
      res.sendStatus(fundResponse.status);
    } else if (fundResponse.status === 'COMPLETED') {
      // Mark expenses as paid and create transactions
      await Promise.all(expenses.map(processPaidExpense(host, remoteUser, fundResponse)));
      // Send 200 to the frontend
      res.sendStatus(200);
      // Simulate transfer success in other environments so transactions don't get stuck.
      if (['development', 'staging'].includes(config.env)) {
        const connectedAccount = await host.getAccountForPaymentProvider('transferwise');
        logger.debug(`Wise: Simulating transfer success for batch group ${fundResponse.id}`);
        for (const transferId of fundResponse.transferIds) {
          const response = await simulateTransferSuccess(connectedAccount, transferId);
          logger.debug(`Wise: Simulated transfer success for transfer ${transferId}`);
          const expense = expenses.find(e => e.data.transfer.id === transferId);
          await expense.update({ data: { ...expense.data, transfer: response } });
          // In development mode we don't have webhooks set up, so we need to manually trigger the event handler.
          if (config.env === 'development') {
            await handleTransferStateChange({
              // eslint-disable-next-line camelcase
              data: { resource: response, current_state: 'outgoing_payment_sent' },
            } as any);
          }
        }
      }
    } else {
      throw new Error(`Could not pay for batch group #${fundResponse.id}, please contact support.`);
    }
  } catch (e) {
    logger.error('Error paying Wise batch group', e);
    reportErrorToSentry(e);
    res
      .status(e.code || 500)
      .send(e.toString())
      .end();
  }
}
