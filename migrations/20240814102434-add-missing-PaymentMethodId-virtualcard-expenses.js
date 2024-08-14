'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      WITH update_data AS (
        SELECT e.id as "ExpenseId", pm.id as "PaymentMethodId"
        FROM "Expenses" e
        INNER JOIN "Collectives" host ON e."HostCollectiveId" = host.id
        INNER JOIN "PaymentMethods" pm ON pm."CollectiveId" = host.id AND pm.service = 'stripe' AND pm.type ='virtual_card'
        WHERE (e.data ->> 'missingDetails')::boolean IS TRUE
        AND e."PaymentMethodId" IS NULL
        AND e."deletedAt" IS NULL
      ) UPDATE "Expenses" e
      SET
        "PaymentMethodId" = update_data."PaymentMethodId",
        "data" = jsonb_set(e.data, '{paymentMethodIdSetFromMigration20240814102434}', 'true'::jsonb)
      FROM update_data
      WHERE e.id = update_data."ExpenseId"
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Expenses" e
      SET
        "PaymentMethodId" = NULL,
        "data" = e.data - 'paymentMethodIdSetFromMigration20240814102434'
      WHERE (e.data ->> 'paymentMethodIdSetFromMigration20240814102434')::boolean IS TRUE
    `);
  },
};
