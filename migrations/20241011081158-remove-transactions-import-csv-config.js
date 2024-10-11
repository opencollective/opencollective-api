'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.removeColumn('TransactionsImports', 'csvConfig');
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.addColumn('TransactionsImports', 'csvConfig', {
      type: Sequelize.JSONB,
      allowNull: true,
    });
  },
};
