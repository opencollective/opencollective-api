'use strict';

module.exports = {
  up: function (queryInterface) {
    return queryInterface.renameTable('Cards', 'PaymentMethods')
    .then(() => queryInterface.removeColumn('PaymentMethods', 'GroupId'))
    .then(() => queryInterface.renameColumn('Transactions', 'paymentMethod', 'payoutMethod'))
  },

  down: function (queryInterface, DataTypes) {
    return queryInterface.addColumn('PaymentMethods', 'GroupId', {
        type: DataTypes.INTEGER,
        references: 'Groups',
        referencesKey: 'id',
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      })
    .then(() => queryInterface.renameTable('PaymentMethods', 'Cards'))
    .then(() => queryInterface.renameColumn('Transactions', 'payoutMethod', 'paymentMethod'));
  }
};
