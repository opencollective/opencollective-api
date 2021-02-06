import Debug from 'debug';
import { Request } from 'express';
import { toNumber } from 'lodash';

import logger from '../../lib/logger';
import { validateWebhookEvent } from '../../lib/paypal';
import models from '../../models';
import { PayoutWebhookRequest } from '../../types/paypal';

import { checkBatchItemStatus } from './payouts';

const debug = Debug('paypal:webhook');

async function handlePayoutTransactionUpdate(req: Request): Promise<void> {
  const event = req.body as PayoutWebhookRequest;
  const expense = await models.Expense.findOne({
    where: { id: toNumber(event.resource.payout_item.sender_item_id) },
    include: [{ model: models.Collective, as: 'collective' }],
  });

  if (!expense) {
    // This is probably some other transfer not executed through our platform.
    debug('event does not match any expense, ignoring');
    return;
  }

  const host = await expense.collective.getHostCollective();
  const [connectedAccount] = await host.getConnectedAccounts({
    where: { service: 'paypal', deletedAt: null },
  });
  if (!connectedAccount) {
    throw new Error(`Host is not connected to PayPal Payouts.`);
  }
  await validateWebhookEvent(connectedAccount, req);

  const item = event.resource;
  await checkBatchItemStatus(item, expense, host);
}

async function webhook(req: Request): Promise<void> {
  debug('new event', req.body);
  if (req.body.event_type.includes('PAYMENT.PAYOUTS-ITEM')) {
    await handlePayoutTransactionUpdate(req);
  } else {
    logger.info(`Received unexpected PayPal Payout event, ignoring it.`);
  }
}

export default webhook;
