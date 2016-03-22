'use strict';

module.exports = {
  up: function (queryInterface, Sequelize) {
    return queryInterface.addColumn(
      'Transactions',
      'DonationId',
      {
          type: Sequelize.INTEGER,
          references: 'Donations',
          referencesKey: 'id',
          onDelete: 'SET NULL',
          onUpdate: 'CASCADE'
      })
    .then(() => queryInterface.addColumn(
      'Transactions',
      'ExpenseId',
      {
        type: Sequelize.INTEGER,
        references: 'Expenses',
        referencesKey: 'id',
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE'
      }))
    .then(() => queryInterface.addColumn(
      'Transactions',
      'OrganizationId',
      {
        type: Sequelize.INTEGER,
        references: 'Organizations',
        referencesKey: 'id',
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE'
      }))
    .then(() => queryInterface.addColumn('Transactions', 'amountInteger', Sequelize.INTEGER))
    .then(() => queryInterface.addColumn('Transactions', 'platformFee', Sequelize.INTEGER))
    .then(() => queryInterface.addColumn('Transactions', 'stripeFee', Sequelize.INTEGER))
    .then(() => queryInterface.addColumn('Transactions', 'paypalFee', Sequelize.INTEGER))
    .then(() => queryInterface.addColumn('Transactions', 'data', Sequelize.JSON));
  },

  down: function (queryInterface) {
    return queryInterface.removeColumn('Transactions', 'DonationId')
    .then(() => queryInterface.removeColumn('Transactions','ExpenseId'))
    .then(() => queryInterface.removeColumn('Transactions', 'OrganizationId'))
    .then(() => queryInterface.removeColumn('Transactions', 'amountInteger'))
    .then(() => queryInterface.removeColumn('Transactions', 'platformFee'))
    .then(() => queryInterface.removeColumn('Transactions', 'stripeFee'))
    .then(() => queryInterface.removeColumn('Transactions', 'paypalFee'))
    .then(() => queryInterface.removeColumn('Transactions', 'data'));
  }
};
