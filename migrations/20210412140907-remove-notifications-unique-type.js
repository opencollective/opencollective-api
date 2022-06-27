'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS "Notifications_type_CollectiveId_UserId";
    `);

    await queryInterface.addIndex('Notifications', ['CollectiveId', 'type', 'channel']);
  },

  down: async () => {
    // Nothing to do
  },
};
