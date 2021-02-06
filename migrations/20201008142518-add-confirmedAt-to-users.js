'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('Users', 'confirmedAt', {
      type: Sequelize.DATE,
      defaultValue: Sequelize.NOW,
      allowNull: true,
    });

    // Mark all existing users as confirmed
    await queryInterface.sequelize.query(`
      UPDATE "Users" SET "confirmedAt" = "createdAt"
    `);
  },

  down: async queryInterface => {
    await queryInterface.removeColumn('Users', 'confirmedAt');
  },
};
