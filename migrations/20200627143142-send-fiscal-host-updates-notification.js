'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface
      .addColumn('Updates', 'notificationAudience', {
        type: Sequelize.STRING,
        defaultValue: null,
      })
      .then(() => {
        return queryInterface.addColumn('UpdateHistories', 'notificationAudience', {
          type: Sequelize.STRING,
          defaultValue: null,
        });
      });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.removeColumn('Updates', 'notificationAudience').then(() => {
      queryInterface.removeColumn('UpdateHistories', 'notificationAudience');
    });
  },
};
