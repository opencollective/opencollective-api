'use strict';

module.exports = {
  up: function (queryInterface, Sequelize) {
    return queryInterface.addColumn(
      'Donations',
      'PaymentMethodId',
      { type: Sequelize.INTEGER,
        references: {
          model: 'PaymentMethods',
          key: 'id'
        },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE'
      });
  },

  down: function (queryInterface) {
    return queryInterface.removeColumn('Donations', 'PaymentMethodId')
  }
};
