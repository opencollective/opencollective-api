'use strict';

module.exports = {
  up: (queryInterface, Sequelize) => {
    return queryInterface.addColumn('Transactions', 'fromAmount', {
      type: Sequelize.INTEGER,
    }).then(() => queryInterface.addColumn('Transactions', 'fromCurrency', {
      type: Sequelize.STRING,
    })).then(() => queryInterface.addColumn('Transactions', 'fromCurrencyRate', {
      type: Sequelize.FLOAT,
    }));
  },

  down: (queryInterface, Sequelize) => {
    return queryInterface.removeColumn('Transactions', 'fromCurrencyRate')
      .then(() => queryInterface.removeColumn('Transactions', 'fromCurrency'))
      .then(() => queryInterface.removeColumn('Transactions', 'fromAmount'));
  }
};
