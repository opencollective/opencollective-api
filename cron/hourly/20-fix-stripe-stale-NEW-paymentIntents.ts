import '../../server/env';

import { isEmpty } from 'lodash';
import moment from 'moment';

import OrderStatuses from '../../server/constants/order-status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../server/constants/paymentMethods';
import logger from '../../server/lib/logger';
import { syncOrder } from '../../server/lib/stripe/sync-order';
import { parseToBoolean } from '../../server/lib/utils';
import { Collective, Op, Order, PaymentMethod } from '../../server/models';
import { runCronJob } from '../utils';

const PAGE_SIZE = 20;

if (parseToBoolean(process.env.SKIP_STRIPE_STALE_NEW_PAYMENT_INTENTS)) {
  console.log('Skipping because SKIP_STRIPE_STALE_NEW_PAYMENT_INTENTS is set.');
  process.exit();
}

async function* staleStripeNewPaymentIntentOrdersPager() {
  const query = {
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
  };

  const total = await Order.count(query);

  console.log(`${total} stale (>=2 days old) stripe payment intent orders with status NEW.`);

  if (total === 0) {
    return;
  }

  let lastOrderId = 0;
  while (true) {
    const pageResult = await Order.findAll({
      ...query,
      where: {
        ...query.where,
        id: { [Op.gt]: lastOrderId },
      },
      order: [['id', 'ASC']],
      limit: PAGE_SIZE,
    });

    if (isEmpty(pageResult)) {
      return;
    }

    lastOrderId = pageResult[pageResult.length - 1].id;

    yield pageResult;
  }
}

async function run() {
  const pager = staleStripeNewPaymentIntentOrdersPager();

  for await (const page of pager) {
    logger.info(`Processing ${page.length} orders...`);
    for (const order of page) {
      try {
        await syncOrder(order, { IS_DRY: process.env.DRY, logging: logger.info });
      } catch (err) {
        logger.error(err);
      }
    }
  }

  logger.info(`Done!`);
}

if (require.main === module) {
  runCronJob('fix-stripe-stale-NEW-paymentIntents', run, 60 * 60);
}
