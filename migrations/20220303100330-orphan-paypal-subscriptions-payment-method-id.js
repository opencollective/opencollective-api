'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      WITH to_update AS (
        SELECT
          t."TransactionGroup",
          pm.id AS "oldPaymentMethodId",
          paypal_subscription."id" AS "PaymentMethodId"
        FROM
          "Transactions" t
        INNER JOIN "PaymentMethods" pm ON
          pm.id = t."PaymentMethodId"
        INNER JOIN "Collectives" fc ON
          fc.id = t."FromCollectiveId"
        INNER JOIN "Transactions" other_order_transactions ON
          other_order_transactions."OrderId" = t."OrderId"
        INNER JOIN "PaymentMethods" paypal_subscription ON
          fc.id = paypal_subscription."CollectiveId"
          AND paypal_subscription.service = 'paypal'
          AND paypal_subscription."type" = 'subscription'
          AND other_order_transactions."PaymentMethodId" = paypal_subscription.id -- ONLY payment methods used FOR the same ORDER in the past
        WHERE
          t.id >= 2000000 -- Small optimization
          AND t."type" = 'CREDIT'
          AND t."isRefund" IS NOT TRUE
          AND pm."type" = 'creditcard'
          AND (
          t."data" ->> 'refundReason' = 'Some PayPal subscriptions were previously not cancelled properly. Please contact support@opencollective.com for any question.'
            OR t."data" -> 'createdFromPaymentReconciliatorAt' IS NOT NULL
        )
        GROUP BY t."TransactionGroup", pm.id, paypal_subscription."id"
        ORDER BY paypal_subscription.id
      ) UPDATE "Transactions" t
      SET
        "PaymentMethodId" = to_update."PaymentMethodId",
        "data" = JSONB_SET("data", '{fixedFromOrphanSubscriptionPaymentMethodIdsMigration}', 'true')
      FROM to_update
      WHERE t."TransactionGroup" = to_update."TransactionGroup"
      AND t."PaymentMethodId" = to_update."oldPaymentMethodId"
    `);
  },

  async down() {
    // nothing to do
  },
};
