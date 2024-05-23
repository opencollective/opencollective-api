/**
 * On the 1st of May: around 5AM UTC, the recurring contributions job got started two times
 * with a few seconds interval. As a result, we double-charged almost 500 contributions.
 *
 * This script specifically target the double-charged contributions for this date and refund them.
 */

import '../../server/env';

import logger from '../../server/lib/logger';
import { refundTransaction } from '../../server/lib/payments';
import models, { Op, sequelize } from '../../server/models';

const DRY_RUN = process.env.DRY_RUN !== 'false';
const LIMIT = parseInt(process.env.LIMIT) || 500;

const main = async () => {
  const orders = await sequelize.query(
    `
    SELECT o.*
    FROM "Orders" o
    INNER JOIN "Transactions" t ON o.id = t."OrderId"
    WHERE t."createdAt" >= '2024-05-01' AND t."createdAt" < '2024-05-02'
    AND t.kind = 'CONTRIBUTION'
    AND t.type = 'CREDIT'
    AND t."RefundTransactionId" IS NULL
    AND o."SubscriptionId" IS NOT NULL
    GROUP BY o.id
    HAVING COUNT(t.id) > 1
    ORDER BY o.id
  `,
    {
      type: sequelize.QueryTypes.SELECT,
      model: models.Order,
      mapToModel: true,
    },
  );

  logger.info(`Found ${orders.length} orders to refund`);
  let count = 0;
  for (const order of orders) {
    if (++count > LIMIT) {
      logger.info(`Reached limit of ${LIMIT}, stopping`);
      break;
    }

    const transactions = await models.Transaction.findAll({
      order: [['createdAt', 'DESC']],
      where: {
        OrderId: order.id,
        type: 'CREDIT',
        kind: 'CONTRIBUTION',
        RefundTransactionId: null,
        createdAt: { [Op.gte]: '2024-05-01', [Op.lt]: '2024-05-02' },
      },
    });

    if (transactions.length !== 2) {
      logger.warn(`Order #${order.id} has ${transactions.length} transactions instead of 2, ignoring`);
      continue;
    }

    if (DRY_RUN) {
      logger.info(`Would refund double-charged contribution #${order.id}`);
    } else {
      logger.info(`Refunding double-charged contribution #${order.id} (${count}/${orders.length})`);
      await refundTransaction(transactions[0], null, `Refunding double-charged contribution #${order.id}`);
    }
  }
};

main()
  .then(() => process.exit())
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
