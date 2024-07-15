'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      WITH subscriptions_with_fixes AS (
        SELECT MAX(t."createdAt") AS "lastChargeDate", s.id
        FROM "Subscriptions"  s
        INNER JOIN "Orders" o ON s.id = o."SubscriptionId"
        INNER JOIN "Transactions" t ON o.id = t."OrderId"
        WHERE s."nextChargeDate" = '2025-01-01 00:00:00.000000 +00:00'
        AND s.interval = 'year'
        AND s."isActive" IS TRUE
        GROUP BY o.id, s.id
        HAVING EXTRACT(YEAR FROM MAX(t."createdAt")) = 2023
      ) UPDATE "Subscriptions" s
      SET
        "nextChargeDate" = "lastChargeDate" + INTERVAL '1 year',
        "nextPeriodStart" = "lastChargeDate" + INTERVAL '1 year'
      FROM subscriptions_with_fixes
      WHERE s.id = subscriptions_with_fixes.id
    `);
  },

  async down() {
    console.log('No down migration needed');
  },
};
