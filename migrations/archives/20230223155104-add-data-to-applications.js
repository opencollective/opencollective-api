'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, DataTypes) {
    await queryInterface.addColumn('Applications', 'data', { type: DataTypes.JSON });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Applications', 'data');
  },
};
