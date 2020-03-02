import { Request } from 'express';

import activities from '../../constants/activities';
import models from '../../models';
import logger from '../../lib/logger';
import { verifyEvent } from '../../lib/transferwise';
import { TransferStateChangeEvent } from '../../types/transferwise';

async function handleTransferStateChange(event: TransferStateChangeEvent): Promise<void> {
  const expense = await models.Expense.findOne({
    include: [{ model: models.Transaction, where: { data: { transfer: { id: event.data.resource.id } } } }],
  });

  if (!expense) {
    // This is probably some other transfer not executed through our platform.
    logger.debug('Ignoring transferwise event.', event);
    return;
  }

  if (event.data.current_state === 'outgoing_payment_sent') {
    logger.info(`Transfer sent, marking expense as paid.`, event);
    await expense.setPaid(expense.lastEditedById);
    await expense.createActivity(activities.COLLECTIVE_EXPENSE_PAID);
  } else if (event.data.current_state === 'funds_refunded') {
    logger.info(`Transfer failed, setting status to Error and deleting existing transactions.`, event);
    await models.Transaction.destroy({ where: { ExpenseId: expense.id } });
    await expense.setError(expense.lastEditedById);
  }
}

async function webhook(req: Request & { rawBody: string }): Promise<void> {
  const event = verifyEvent(req);

  switch (event.event_type) {
    case 'transfers#state-change':
      await handleTransferStateChange(event as TransferStateChangeEvent);
      break;
    default:
      break;
  }
}

export default webhook;
