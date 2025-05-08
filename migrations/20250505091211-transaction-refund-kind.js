'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('Transactions', 'refundKind', {
      type: Sequelize.ENUM('REFUND', 'REJECT', 'EDIT', 'DUPLICATE', 'DISPUTE'),
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Transactions', 'refundKind');
  },
};
