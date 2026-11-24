import config from 'config';
import type Express from 'express';

import { Service } from '../constants/connected-account';
import expenseStatus from '../constants/expense-status';
import {
  enforcePayout2FA,
  ExpensePayout2FALimitCount,
  getExpenseFees,
  releaseExpensePayout2FALimit,
  setTransferWiseExpenseAsProcessing,
} from '../graphql/common/expenses';
import { checkRemoteUserCanUseExpenses } from '../graphql/common/scope-check';
import { fetchAccountWithReference } from '../graphql/v2/input/AccountReferenceInput';
import { fetchExpenseWithReference } from '../graphql/v2/input/ExpenseReferenceInput';
import { convertToCurrency } from '../lib/currency';
import errors from '../lib/errors';
import logger from '../lib/logger';
import { reportErrorToSentry, reportMessageToSentry } from '../lib/sentry';
import { simulateTransferSuccess } from '../lib/transferwise';
import twoFactorAuthLib from '../lib/two-factor-authentication';
import { wiseIdsEqual } from '../lib/wise-id';
import models, { Op } from '../models';
import transferwise from '../paymentProviders/transferwise';
import { handleTransferStateChange } from '../paymentProviders/transferwise/webhook';
import { BatchGroup, TransferStateChangeEvent } from '../types/transferwise';

const getErrorStatusCode = (e: unknown): number => {
  if (typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'number') {
    return e.code;
  }
  const extensionsCode =
    typeof e === 'object' && e !== null && 'extensions' in e
      ? (e.extensions as { code?: unknown } | undefined)?.code
      : undefined;
  switch (extensionsCode) {
    case 'Unauthorized':
      return 401;
    case 'Forbidden':
    case 'FeatureNotAllowedForUser':
      return 403;
    case 'NotFound':
      return 404;
    case 'RateLimitExceeded':
      return 429;
    default:
      return 500;
  }
};

/** 2FA errors are sent as JSON, in the format the frontend expects to prompt for a code and retry */
const send2FAError = (e: unknown, res: Express.Response): boolean => {
  const extensions =
    typeof e === 'object' && e !== null && 'extensions' in e
      ? (e.extensions as { code?: string; supportedMethods?: unknown; authenticationOptions?: unknown })
      : undefined;
  if (extensions?.code === '2FA_REQUIRED') {
    res.status(401).send({
      message: (e as Error).message,
      supportedMethods: extensions.supportedMethods,
      authenticationOptions: extensions.authenticationOptions,
    });
    return true;
  } else if (extensions?.code === 'INVALID_2FA_CODE') {
    res.status(401).send({ message: (e as Error).message });
    return true;
  }

  return false;
};

/** The amount the batch takes out of the host's account, for the payout 2FA rolling limit */
const getBatchTotalInHostCurrency = async (host, expenses): Promise<number> => {
  const amounts = await Promise.all(expenses.map(e => convertToCurrency(e.amount, e.currency, host.currency)));
  return amounts.reduce((total, amount) => total + Number(amount), 0);
};

const processPaidExpense = (host, remoteUser, batchGroup: BatchGroup) => async expense => {
  try {
    await expense.reload();
    if (expense.data?.transfer) {
      const payoutMethod = await expense.getPayoutMethod();
      const { feesInHostCurrency } = await getExpenseFees(expense, host, { payoutMethod, useExistingWiseData: true });
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
  req: Express.Request<Record<string, string>, unknown, { expenseIds: Array<string>; hostId: string }>,
  res: Express.Response,
): Promise<void> {
  let countedTowards2FARollingLimit: ExpensePayout2FALimitCount | null = null;
  try {
    const { remoteUser, headers, body } = req;
    if (!remoteUser) {
      throw new errors.Unauthorized('User needs to be logged in');
    }
    checkRemoteUserCanUseExpenses(req);

    const host = await fetchAccountWithReference({ id: body.hostId });
    if (!host) {
      throw new errors.NotFound('Could not find host collective');
    }
    if (!remoteUser.isAdmin(host.id)) {
      throw new errors.Unauthorized('User must be admin of host collective');
    }
    if (host.settings?.transferwise?.ott !== true) {
      throw new errors.Forbidden('Wise batch payments require the host to use Wise SCA (transferwise.ott)');
    }
    const expenseIds = await Promise.all(
      body.expenseIds?.map(id => fetchExpenseWithReference({ id }).then(expense => expense?.id)),
    );
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
    const x2faApproval = headers['x-2fa-approval'] as string;

    let fundResponse: Awaited<ReturnType<typeof transferwise.payExpensesBatchGroup>>;
    if (x2faApproval) {
      // The payout 2FA check ran when the batch was sent to Wise, and the approval code it got back can only be used
      // by the same admin. The host's 2FA policy still applies.
      await twoFactorAuthLib.enforceForAccount(req, host, { onlyAskOnLogin: true });
      fundResponse = await transferwise.approveExpenseBatchGroupPayment({ host, x2faApproval, remoteUser });
    } else {
      // Paying the batch is what moves the money, so it goes through the payout 2FA check for its total
      const totalInHostCurrency = await getBatchTotalInHostCurrency(host, expenses);
      countedTowards2FARollingLimit = await enforcePayout2FA(
        req,
        host,
        { amount: totalInHostCurrency, currency: host.currency },
        { isAutomatedPayout: true },
      );
      fundResponse = await transferwise.payExpensesBatchGroup({ host, expenses, remoteUser });
    }

    // If OTT response, proxy it to the frontend and return early
    if ('status' in fundResponse && 'headers' in fundResponse) {
      countedTowards2FARollingLimit = null; // Waiting for approval: stays counted
      res.setHeader('x-2fa-approval', fundResponse.headers['x-2fa-approval']);
      res.sendStatus(fundResponse.status);
    } else if (fundResponse.status === 'COMPLETED') {
      countedTowards2FARollingLimit = null; // Paid: stays counted, whatever happens next
      // Mark expenses as paid and create transactions
      await Promise.all(expenses.map(processPaidExpense(host, remoteUser, fundResponse)));
      // Send 200 to the frontend
      res.sendStatus(200);
      // Simulate transfer success in other environments so transactions don't get stuck.
      if (['development', 'staging'].includes(config.env)) {
        const connectedAccount = await host.getAccountForPaymentProvider(Service.TRANSFERWISE);
        logger.debug(`Wise: Simulating transfer success for batch group ${fundResponse.id}`);
        for (const transferId of fundResponse.transferIds) {
          const response = await simulateTransferSuccess(connectedAccount, transferId);
          logger.debug(`Wise: Simulated transfer success for transfer ${transferId}`);
          const expense = expenses.find(e => wiseIdsEqual(e.data.transfer.id, transferId));
          await expense.update({ data: { ...expense.data, transfer: response } });
          // In development mode we don't have webhooks set up, so we need to manually trigger the event handler.
          if (config.env === 'development') {
            await handleTransferStateChange({
              // eslint-disable-next-line camelcase
              data: { resource: response, current_state: 'outgoing_payment_sent' },
            } as unknown as TransferStateChangeEvent);
          }
        }
      }
    } else {
      throw new Error(`Could not pay for batch group #${fundResponse.id}, please contact support.`);
    }
  } catch (e) {
    // The batch was not paid: its amount does not count towards the rolling limit. A batch that Wise asked to approve
    // stays counted, even if the admin never approves it.
    await releaseExpensePayout2FALimit(req, countedTowards2FARollingLimit);
    if (send2FAError(e, res)) {
      return;
    }

    logger.error('Error paying Wise batch group', e);
    const statusCode = getErrorStatusCode(e);
    // Refused requests are expected, like too many 2FA attempts or an admin without 2FA on a host that requires it
    if (statusCode >= 500) {
      reportErrorToSentry(e);
    }
    const message = e.message || 'An error occurred while processing the Wise batch payment.';
    res.status(statusCode).send(message).end();
  }
}
