import '../../server/env.js';

import logger from '../../server/lib/logger.js';
import { createRefundTransaction } from '../../server/lib/payments.js';
import models, { sequelize } from '../../server/models/index.js';

/**
 * Refund the wrongly recorded double transactions for PayPal payment, to make sure
 * they will be deducted from the next settlement.
 */
const main = async (): Promise<void> => {
  const doubleTransactionsInfos = await sequelize.query(
    `
    SELECT t."OrderId", COALESCE(t."data" -> 'paypalSale' ->> 'id', t."data" -> 'capture' ->> 'id') AS "paypalId", array_agg(DISTINCT t.id) AS "transactionIds"
    FROM "Transactions" t 
    INNER JOIN "PaymentMethods" pm ON t."PaymentMethodId" = pm.id
    INNER JOIN "Orders" o ON t."OrderId" = o.id
    WHERE pm.service = 'paypal'
    AND t.kind = 'CONTRIBUTION'
    AND t."type" = 'CREDIT'
    AND t."deletedAt" IS NULL
    AND t."isRefund" IS FALSE
    AND t."RefundTransactionId" IS NULL
    GROUP BY t."OrderId", COALESCE(t."data" -> 'paypalSale' ->> 'id', t."data" -> 'capture' ->> 'id')
    HAVING count(t.id) > 1
    ORDER BY t."OrderId" DESC
  `,
    { raw: true, type: sequelize.QueryTypes.SELECT },
  );

  for (const doubleTransactionInfo of doubleTransactionsInfos) {
    const sortedTransactionIds = [...doubleTransactionInfo.transactionIds].sort();
    const transactionIdsToRefund = sortedTransactionIds.slice(1); // Keep the first transaction
    const transactionsToRefund = await models.Transaction.findAll({ where: { id: transactionIdsToRefund } });

    if (process.env.DRY) {
      logger.info(
        `Would refund ${transactionsToRefund.length} transactions for order ${doubleTransactionInfo.OrderId}`,
      );
    } else {
      await Promise.all(
        transactionsToRefund.map(async transaction => {
          await createRefundTransaction(
            transaction,
            transaction.paymentProcessorFeeInHostCurrency,
            { refundedFromDoubleTransactionsScript: true },
            null,
          );
        }),
      );
    }
  }
};

main()
  .then(() => process.exit(0))
  .catch(e => {
    console.error(e);
    process.exit(1);
  });
