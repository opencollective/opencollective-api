'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('Users', 'yubikeyDeviceId', {
      type: Sequelize.STRING,
      allowNull: true,
      defaultValue: null,
    });
    await queryInterface.addColumn('UserHistories', 'yubikeyDeviceId', {
      type: Sequelize.STRING,
      allowNull: true,
      defaultValue: null,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Users', 'yubikeyDeviceId');
    await queryInterface.removeColumn('UserHistories', 'yubikeyDeviceId');
  },
};
