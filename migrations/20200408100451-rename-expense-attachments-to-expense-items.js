'use strict';

module.exports = {
  up: (queryInterface, Sequelize) => {
    return queryInterface.renameTable('ExpenseAttachments', 'ExpenseItems');
  },

  down: (queryInterface, Sequelize) => {
    return queryInterface.renameTable('ExpenseItems', 'ExpenseAttachments');
  },
};
