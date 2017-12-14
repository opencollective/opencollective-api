'use strict';

// TODO: populate type field for existing paymentMethods

module.exports = {
  up: (queryInterface, Sequelize) => {
    return queryInterface.addColumn('PaymentMethods', 'type', {
        type: Sequelize.STRING
      })
  },

  down: (queryInterface, Sequelize) => {
    return queryInterface.removeColumn('PaymentMethods', 'type');
  }
};
