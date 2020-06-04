import Debug from 'debug';
import { Request } from 'express';
import { toNumber } from 'lodash';

import logger from '../../lib/logger';
import models from '../../models';
import { PayoutWebhookRequest } from '../../types/paypal';

import { checkBatchItemStatus } from './payouts';

const debug = Debug('paypal:webhook');

async function handlePayoutTransactionUpdate(event: PayoutWebhookRequest): Promise<void> {
  const expense = await models.Expense.findOne({
    where: { id: toNumber(event.resource.payout_item.sender_item_id) },
    include: [{ model: models.Collective, as: 'collective' }],
  });

  if (!expense) {
    // This is probably some other transfer not executed through our platform.
    return;
  }

  const host = await expense.collective.getHostCollective();
  const item = event.resource;
  await checkBatchItemStatus(item, expense, host);
}

async function webhook(req: Request): Promise<void> {
  const event = req.body as PayoutWebhookRequest;
  debug('new event', event);
  if (event.event_type.includes('PAYMENT.PAYOUTS-ITEM')) {
    await handlePayoutTransactionUpdate(event);
  } else {
    logger.info(`Received unexpected PayPal Payout event, ignoring it.`);
  }
}

export default webhook;
