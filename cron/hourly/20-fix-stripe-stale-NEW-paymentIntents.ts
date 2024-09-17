import '../../server/env';

import moment from 'moment';

import OrderStatuses from '../../server/constants/order-status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../server/constants/paymentMethods';
import logger from '../../server/lib/logger';
import { syncOrder } from '../../server/lib/stripe/sync-order';
import { Collective, Op, Order, PaymentMethod } from '../../server/models';
import { runCronJob } from '../utils';

export async function run() {
  logger.info('Starting job to fix stripe stale NEW paymentIntents');

  const results = await Order.findAndCountAll({
    limit: 20,
    include: [
      {
        model: PaymentMethod,
        as: 'paymentMethod',
        where: {
          service: PAYMENT_METHOD_SERVICE.STRIPE,
          type: PAYMENT_METHOD_TYPE.PAYMENT_INTENT,
        },
        required: true,
      },
      { model: Collective, as: 'collective' },
    ],
    where: {
      status: OrderStatuses.NEW,
      data: {
        paymentIntent: {
          id: {
            [Op.ne]: null,
          },
        },
      },
      createdAt: {
        [Op.lte]: moment().subtract(2, 'days').toDate(),
      },
    },
  });

  logger.info(`${results.count} stale (>=2 days old) stripe payment intent orders with status NEW.`);
  logger.info(`Processing ${results.rows.length} orders...`);
  for (const order of results.rows) {
    await syncOrder(order, { IS_DRY: process.env.DRY, logging: logger.info });
  }
  logger.info(`Done!`);
}

if (require.main === module) {
  runCronJob('fix-stripe-stale-NEW-paymentIntents', run, 60 * 60);
}
