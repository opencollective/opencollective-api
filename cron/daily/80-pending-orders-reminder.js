import '../../server/env';

import status from '../../server/constants/order-status';
import logger from '../../server/lib/logger';
import { sendReminderPendingOrderEmail } from '../../server/lib/payments';
import models, { Op, sequelize } from '../../server/models';
import { runCronJob } from '../utils';

const REMINDER_DAYS = 4;

const fetchPendingOrders = async date => {
  const dateFrom = new Date(date);
  dateFrom.setUTCHours(0, 0, 0, 0);
  const dateTo = new Date(dateFrom);
  dateTo.setUTCHours(23, 59, 59);

  const orders = await models.Order.findAll({
    where: {
      [Op.and]: [
        {
          status: status.PENDING,
          deletedAt: null,
          PaymentMethodId: null,
          createdAt: { [Op.gte]: dateFrom, [Op.lte]: dateTo },
        },
        // Expected funds created through `createPendingOrder` (data.isPendingContribution)
        // are already tracked by the host and are not manual bank transfers awaiting
        // confirmation, so they must not receive the pending order reminder.
        sequelize.literal(`COALESCE("Order"."data"->>'isPendingContribution', 'false') != 'true'`),
      ],
    },
    include: [
      { model: models.Collective, as: 'fromCollective' },
      { model: models.User, as: 'createdByUser' },
      { model: models.Collective, as: 'collective' },
    ],
  });

  return orders;
};

export const run = async () => {
  const reminderDate = process.env.START_DATE ? new Date(process.env.START_DATE) : new Date();
  reminderDate.setDate(reminderDate.getDate() - REMINDER_DAYS);

  const orders = await fetchPendingOrders(reminderDate);
  for (const order of orders) {
    await sendReminderPendingOrderEmail(order);
  }

  logger.info('Done.');
};

if (require.main === module) {
  runCronJob('pending-orders-reminder', run, 24 * 60 * 60);
}
