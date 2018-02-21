'use strict';

module.exports = {
  up: (queryInterface, Sequelize) => {
    return queryInterface.addColumn('Transactions', 'refundId', { 
      type: Sequelize.INTEGER,
      references: { key: 'id', model: 'Transactions' }
    });
  },

  down: (queryInterface, Sequelize) => {
    return queryInterface.removeColumn('Transactions', 'refundId');
  }
};
