#!/usr/bin/env ./node_modules/.bin/babel-node
import '../../server/env.js';

import { omit } from 'lodash-es';

import models, { sequelize } from '../../server/models/index.js';
import { paypalRequestV2 } from '../../server/paymentProviders/paypal/api.js';
import { recordPaypalCapture } from '../../server/paymentProviders/paypal/payment.js';
import { PaypalCapture } from '../../server/types/paypal.js';

const migrate = async () => {
  const orders = await sequelize.query(
    `
    SELECT
      o.*,
      pm.data -> 'orderId' AS "__paypalOrderId__"
    FROM
      "Orders" o
    INNER JOIN
      "PaymentMethods" pm ON o."PaymentMethodId" = pm.id
    INNER JOIN
      "Collectives" c ON o."CollectiveId" = c.id
    LEFT JOIN "Transactions" t
      ON t."OrderId" = o.id
    WHERE
      o."data" -> 'error' ->> 'message' = 'createFromContributionPayload: currency should be set'
      AND t.id IS NULL
  `,
    {
      type: sequelize.QueryTypes.SELECT,
      model: models.Order,
      mapToModel: true,
    },
  );

  for (const order of orders) {
    // Preload data
    order.collective = await order.getCollective();
    order.paymentMethod = await order.getPaymentMethod();
    const hostCollective = await order.collective.getHostCollective();

    // Fetch payment info
    const paypalOrderId = order.dataValues.__paypalOrderId__;
    const paypalOrderUrl = `checkout/orders/${paypalOrderId}`;
    const paypalOrderDetails = await paypalRequestV2(paypalOrderUrl, hostCollective, 'GET');
    const captureId = paypalOrderDetails.purchase_units[0].payments.captures[0].id;
    const captureUrl = `payments/captures/${captureId}`;
    const captureDetails = (await paypalRequestV2(captureUrl, hostCollective, 'GET')) as PaypalCapture;

    // Record payment info
    if (process.env.DRY) {
      console.log(`Would migrate order #${order.id} with ${JSON.stringify(captureDetails)}`);
    } else {
      await recordPaypalCapture(order, captureDetails);
      const newOrderData = omit(order.data, 'error');
      await order.update({ processedAt: new Date(), status: 'PAID', data: newOrderData });
    }
  }
};

const main = async () => {
  return migrate();
};

main()
  .then(() => process.exit())
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
