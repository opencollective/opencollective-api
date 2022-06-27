'use strict';

/**
 * Migrate all entries (1198) missed by `migrations/20201016085526-add-platform-contribution-transaction-group.js`,
 * ignoring the ones already migrated.
 */
module.exports = {
  up: async queryInterface => {
    return queryInterface.sequelize.query(`
      UPDATE
        "Transactions"
      SET
        "PlatformTipForTransactionGroup" = transaction_links."TransactionGroup"
      FROM (
        SELECT
          t.id AS transaction_id,
          t."TransactionGroup" AS "TransactionGroup",
          platform_tip.id AS platform_tip_id
        FROM
          "Transactions" t
        INNER JOIN "Transactions" platform_tip ON (
          t."OrderId" = platform_tip."OrderId"
          AND t."type" = platform_tip."type"
          AND t.id != platform_tip.id 
        )
        INNER JOIN "PaymentMethods" pm ON
          t."PaymentMethodId" = pm.id
        LEFT JOIN "PaymentMethods" spm ON
          pm."SourcePaymentMethodId" = spm.id
        WHERE
          -- We only want to migrate transactions that have been missed by the previous migration
          platform_tip."PlatformTipForTransactionGroup" IS NULL
          AND (t.data ->> 'isFeesOnTop')::boolean = TRUE
          -- platform_tip: Only transactions on "opencollective" (#8686)
          AND t."FromCollectiveId" != 8686 AND t."CollectiveId" != 8686
          AND (
            (platform_tip.type = 'CREDIT' AND platform_tip."CollectiveId" = 8686)
            OR (platform_tip.type = 'DEBIT' AND platform_tip."FromCollectiveId" = 8686)
          )
          -- Link based on payment method
          AND (
            -- Stripe
            (
              ((pm.service = 'stripe' AND pm.type = 'creditcard') OR (spm.service = 'stripe' AND spm.type = 'creditcard'))
              AND (platform_tip.data -> 'charge' ->> 'id') = (t.data -> 'charge' ->> 'id')
            )
            -- PayPal
            OR (pm.service = 'paypal' AND pm.type = 'payment' AND (platform_tip.data ->> 'id') = (t.data ->> 'id'))
            -- Collective PM
            OR (pm.service = 'opencollective' AND pm.type = 'collective' )
          )
        GROUP BY t.id, platform_tip.id
      ) AS transaction_links
      WHERE
        "Transactions".id = transaction_links.platform_tip_id
    `);
  },

  down: async () => {
    // Nothing to do
  },
};
