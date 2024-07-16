import '../../server/env';

import status from '../../server/constants/order-status';
import logger from '../../server/lib/logger';
import { sendReminderPendingOrderEmail } from '../../server/lib/payments';
import models, { Op } from '../../server/models';
import { runCronJob } from '../utils';

const REMINDER_DAYS = 4;

const fetchPendingOrders = async date => {
  const dateFrom = new Date(date);
  dateFrom.setUTCHours(0, 0, 0, 0);
  const dateTo = new Date(dateFrom);
  dateTo.setUTCHours(23, 59, 59);

  const orders = await models.Order.findAll({
    where: {
      status: status.PENDING,
      deletedAt: null,
      PaymentMethodId: null,
      createdAt: { [Op.gte]: dateFrom, [Op.lte]: dateTo },
    },
    include: [
      { model: models.Collective, as: 'fromCollective' },
      { model: models.User, as: 'createdByUser' },
      { model: models.Collective, as: 'collective' },
    ],
  });

  return orders;
};

const run = async () => {
  const reminderDate = process.env.START_DATE ? new Date(process.env.START_DATE) : new Date();
  reminderDate.setDate(reminderDate.getDate() - REMINDER_DAYS);

  const orders = await fetchPendingOrders(reminderDate);
  for (const order of orders) {
    await sendReminderPendingOrderEmail(order);
  }

  logger.info('Done.');
};

runCronJob('pending-orders-reminder', run, 24 * 60 * 60);
