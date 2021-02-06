'use strict';

module.exports = {
  up: queryInterface => {
    return queryInterface.sequelize.query(`
      DELETE FROM "Notifications"
      WHERE "channel" = 'webhook'
      AND "webhookUrl" IS NULL;
    `);
  },

  down: () => {},
};
