'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const webhooks = await queryInterface.sequelize.query(
      `
      DELETE FROM "Notifications"
      WHERE channel = 'webhook'
      AND "CollectiveId" IS NULL
      RETURNING *
    `,
      {
        type: queryInterface.sequelize.QueryTypes.SELECT,
      },
    );

    await queryInterface.sequelize.query(
      `
      INSERT INTO "MigrationLogs"
      ("createdAt", "type", "description", "CreatedByUserId", "data")
      VALUES (
        NOW(),
        'MIGRATION',
        'migrations/20241024103852-remove-invalid-webhooks',
        NULL,
        :data
      )
    `,
      {
        replacements: { data: JSON.stringify(webhooks) },
        type: queryInterface.sequelize.QueryTypes.INSERT,
      },
    );
  },

  async down() {
    console.log(`No restore for this migration, look at the migration log for the deleted webhooks`);
  },
};
