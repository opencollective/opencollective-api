import '../../server/env';

import { isEmpty } from 'lodash';
import moment from 'moment';

import OrderStatuses from '../../server/constants/order-status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../server/constants/paymentMethods';
import { syncOrder } from '../../server/lib/stripe/sync-order';
import { Collective, Op, Order, PaymentMethod } from '../../server/models';

const PAGE_SIZE = 20;

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

  let offset = 0;
  while (true) {
    const pageResult = await Order.findAll({
      ...query,
      limit: PAGE_SIZE,
      offset,
    });

    if (isEmpty(pageResult)) {
      return;
    }

    yield pageResult;

    offset += PAGE_SIZE;
  }
}

const main = async () => {
  const pager = staleStripeNewPaymentIntentOrdersPager();

  for await (const page of pager) {
    console.log(`Processing ${page.length} orders...`);
    for (const order of page) {
      try {
        await syncOrder(order, { IS_DRY: process.env.DRY });
      } catch (err) {
        console.error(err);
      }
    }
  }

  console.log(`Done!`);
};

main()
  .then(() => process.exit())
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
