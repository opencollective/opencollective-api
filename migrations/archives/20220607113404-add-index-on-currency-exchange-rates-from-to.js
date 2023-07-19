'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.addIndex('CurrencyExchangeRates', ['from', 'to', 'createdAt']);
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('CurrencyExchangeRates', ['from', 'to', 'createdAt']);
  },
};
