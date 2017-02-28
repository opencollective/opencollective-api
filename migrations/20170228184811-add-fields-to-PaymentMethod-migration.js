'use strict';

module.exports = {
  up: function (queryInterface, Sequelize) {
    return queryInterface.addColumn('PaymentMethods', 'startDate', {
      type: Sequelize.DATE
    })
    .then(() => queryInterface.addColumn('PaymentMethods', 'endDate', {
      type: Sequelize.DATE
    }))
  },

  down: function (queryInterface, Sequelize) {
    return queryInterface.removeColumn('PaymentMethods', 'startDate')
    .then(() => queryInterface.addColumn('PaymentMethods', 'endDate'))
  }
};
