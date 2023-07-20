'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const deletedWebhooks = await queryInterface.sequelize.query(
      `
      DELETE FROM "Notifications"
      WHERE "webhookUrl" ILIKE '%webhooks.gitter.im%'
      RETURNING *
    `,
      {
        type: queryInterface.sequelize.QueryTypes.DELETE,
      },
    );

    console.log(deletedWebhooks);

    await queryInterface.sequelize.query(
      `
      INSERT INTO "MigrationLogs" ("type", "createdAt", "description", "data")
      VALUES ('MIGRATION', NOW(), 'Remove Gitter webhooks', :data)
    `,
      {
        replacements: {
          data: JSON.stringify({ deletedWebhooks }),
        },
      },
    );
  },

  async down(queryInterface) {
    const [migrationLog] = await queryInterface.sequelize.query(
      `SELECT * FROM "MigrationLogs" WHERE "type" = 'MIGRATION' AND "description" = 'Remove Gitter webhooks'`,
      { type: queryInterface.sequelize.QueryTypes.SELECT },
    );

    await queryInterface.sequelize.query(
      `
      INSERT INTO "Notifications" ("type", "channel", "active", "createdAt", "updatedAt", "UserId", "CollectiveId", "webhookUrl")
      VALUES ${migrationLog.data.deletedWebhooks.map(webhook => {
        return `(
          '${webhook.type}',
          '${webhook.channel}',
          ${webhook.active},
          '${webhook.createdAt}',
          '${webhook.updatedAt}',
          ${webhook.UserId || 'NULL'},
          ${webhook.CollectiveId},
          '${webhook.webhookUrl}'
        )`;
      })}
    `,
      {
        type: queryInterface.sequelize.QueryTypes.INSERT,
      },
    );

    await queryInterface.sequelize.query(`
      DELETE FROM "MigrationLogs" WHERE "id" = ${migrationLog.id}
    `);
  },
};
