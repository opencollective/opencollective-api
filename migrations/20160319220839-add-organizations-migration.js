'use strict';

module.exports = {
  up: function (queryInterface, Sequelize) {
    return queryInterface.createTable(
      'Organizations', {
        id: {
          type: Sequelize.INTEGER,
          primaryKey: true,
          autoIncrement: true
        },

        name: Sequelize.STRING,

        isHost: {
          type: Sequelize.BOOLEAN,
          defaultValue: false
        },

        description: Sequelize.TEXT('long'),
        website: Sequelize.STRING,
        twitterHandle: Sequelize.STRING,

        createdAt: {
          type: Sequelize.DATE,
          defaultValue: Sequelize.NOW
        },

        updatedAt: {
          type: Sequelize.DATE,
          defaultValue: Sequelize.NOW
        },

        deletedAt: {
          type: Sequelize.DATE
        }
      }, {
        paranoid: true
      });
  },

  down: function (queryInterface) {
    return queryInterface.dropTable('Organizations');
  }
};
