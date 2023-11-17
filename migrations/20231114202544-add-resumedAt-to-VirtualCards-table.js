'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, DataTypes) {
    await queryInterface.addColumn('VirtualCards', 'resumedAt', {
      type: DataTypes.DATE,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('VirtualCards', 'resumedAt');
  },
};
