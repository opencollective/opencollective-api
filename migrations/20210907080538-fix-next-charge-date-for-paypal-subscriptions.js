'use strict';

module.exports = {
  up: async queryInterface => {
    // Fix charge number for all paypal subscriptions
    await queryInterface.sequelize.query(`
      WITH subscriptions_with_fixes AS (
        SELECT
          s.*,
          COUNT(t.id) AS "fixedChargeNumber"
        FROM
          "Subscriptions" s
        INNER JOIN "Orders" o ON
          o."SubscriptionId" = s.id
          AND o."deletedAt" IS NULL
        INNER JOIN "Transactions" t ON
          t."OrderId" = o.id
          AND t.kind = 'CONTRIBUTION'
          AND t."type" = 'CREDIT'
          AND t."deletedAt" IS NULL
          AND t."isRefund" IS FALSE
        WHERE
          "paypalSubscriptionId" IS NOT NULL
        GROUP BY
          s.id
        HAVING
          COUNT(t.id) != s."chargeNumber" 
      ) UPDATE "Subscriptions" s
      SET "chargeNumber" = subscriptions_with_fixes."fixedChargeNumber"
      FROM subscriptions_with_fixes
      WHERE s.id = subscriptions_with_fixes.id
    `);

    // Fix next charge date for all paypal subscriptions
    await queryInterface.sequelize.query(`
      WITH subscriptions_with_fixes AS (
        SELECT s.id, MAX(t."createdAt") AS "lastChargeDate"
        FROM
          "Subscriptions" s
        INNER JOIN "Orders" o ON
          o."SubscriptionId" = s.id
          AND o."deletedAt" IS NULL
        INNER JOIN "Transactions" t ON
          t."OrderId" = o.id
          AND t.kind = 'CONTRIBUTION'
          AND t."type" = 'CREDIT'
          AND t."deletedAt" IS NULL
          AND t."isRefund" IS FALSE
        WHERE
          "paypalSubscriptionId" IS NOT NULL
          AND s."interval" = 'month' -- No yearly contributions affected by this bug 
        GROUP BY
          s.id
        HAVING
          MAX(t."createdAt") > s."nextChargeDate" 
      ) UPDATE "Subscriptions" s
      SET "nextChargeDate" = "lastChargeDate" + INTERVAL '1 month'
      FROM subscriptions_with_fixes
      WHERE s.id = subscriptions_with_fixes.id
    `);

    // Reset nextChargeDate for cancelled paypal subscriptions
    await queryInterface.sequelize.query(`
      UPDATE "Subscriptions"
      SET "nextChargeDate" = NULL
      WHERE "isActive" IS FALSE
      AND "deactivatedAt" IS NOT NULL
      AND "nextChargeDate" IS NOT NULL
      AND "isManagedExternally" IS TRUE
    `);
  },

  down: async () => {
    // No coming back from this one
  },
};
