'use strict';

module.exports = {
  up: (queryInterface, Sequelize) => {
    return queryInterface.addColumn('PaymentMethods', 'type', {
      type: Sequelize.STRING
    })
    .then(queryInterface.sequelize.query(`
      UPDATE "PaymentMethods"
        SET "type" = 'creditcard'
      WHERE type IS NULL AND service ilike 'stripe'
      `))
  },

  down: (queryInterface, Sequelize) => {
    return queryInterface.removeColumn('PaymentMethods', 'type');
  }
};
