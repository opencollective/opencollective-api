import '../../server/env';

import moment from 'moment';

import OrderStatuses from '../../server/constants/order-status';
import { PAYMENT_METHOD_SERVICE, PAYMENT_METHOD_TYPE } from '../../server/constants/paymentMethods';
import { syncOrder } from '../../server/lib/stripe/sync-order';
import { Collective, Op, Order, PaymentMethod } from '../../server/models';

const main = async () => {
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

  console.log(`${results.count} stale (>=2 days old) stripe payment intent orders with status NEW.`);

  console.log(`Processing ${results.rows.length} orders...`);
  for (const order of results.rows) {
    await syncOrder(order, { IS_DRY: process.env.DRY });
  }
  console.log(`Done!`);
};

main()
  .then(() => process.exit())
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
