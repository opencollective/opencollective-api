'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const [impactedOrders] = await queryInterface.sequelize.query(
      `
      UPDATE "Orders"
      SET "data" = JSONB_SET("data", '{pausedBy}', "data" -> 'messageSource')
      WHERE status = 'PAUSED'
      AND data -> 'messageSource' IS NOT NULL
      AND data -> 'pausedBy' IS NULL
      RETURNING id
    `,
      {
        type: queryInterface.sequelize.QueryTypes.UPDATE,
      },
    );

    if (impactedOrders.length > 0) {
      await queryInterface.sequelize.query(
        `
        INSERT INTO "MigrationLogs" ("type", "createdAt", "description", "data")
        VALUES ('MIGRATION', NOW(), '20240905064406-set-orders-paused-by', :data)
      `,
        {
          replacements: {
            data: JSON.stringify({ ordersUpdated: impactedOrders.map(o => o.id) }),
          },
        },
      );
    }
  },

  async down() {
    console.log('No rollback for this migration, see MigrationLogs for the list of orders updated');
  },
};
