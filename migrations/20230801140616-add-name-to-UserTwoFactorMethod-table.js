'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    queryInterface.addColumn('UserTwoFactorMethods', 'name', {
      type: Sequelize.TEXT,
      allowNull: false,
      defaultValue: '2FA method',
    });
  },

  async down(queryInterface) {
    queryInterface.removeColumn('UserTwoFactorMethods', 'name');
  },
};
