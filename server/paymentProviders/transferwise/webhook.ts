import { Request } from 'express';
import moment from 'moment';
import { Op } from 'sequelize';

import activities from '../../constants/activities';
import logger from '../../lib/logger';
import { verifyEvent } from '../../lib/transferwise';
import models from '../../models';
import { TransferStateChangeEvent } from '../../types/transferwise';

async function handleTransferStateChange(event: TransferStateChangeEvent): Promise<void> {
  const transaction = await models.Transaction.findOne({
    where: {
      data: { transfer: { id: event.data.resource.id } },
      updatedAt: {
        [Op.gte]: moment().subtract(10, 'days').toDate(),
      },
    },
    include: [{ model: models.Expense, as: 'Expense' }],
  });

  if (!transaction || !transaction.Expense) {
    // This is probably some other transfer not executed through our platform.
    logger.debug('Ignoring transferwise event.', event);
    return;
  }
  const expense = transaction.Expense;

  if (event.data.current_state === 'outgoing_payment_sent') {
    logger.info(`Transfer sent, marking expense as paid.`, event);
    await expense.setPaid(expense.lastEditedById);
    const user = await models.User.findByPk(expense.lastEditedById);
    await expense.createActivity(activities.COLLECTIVE_EXPENSE_PAID, user);
  } else if (event.data.current_state === 'funds_refunded') {
    logger.info(`Transfer failed, setting status to Error and deleting existing transactions.`, event);
    await models.Transaction.destroy({ where: { ExpenseId: expense.id } });
    await expense.setError(expense.lastEditedById);
    await expense.createActivity(activities.COLLECTIVE_EXPENSE_ERROR);
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
