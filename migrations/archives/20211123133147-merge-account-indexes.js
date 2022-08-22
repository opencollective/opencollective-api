'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.addIndex('Transactions', ['CreatedByUserId'], { concurrently: true });
    await queryInterface.addIndex('Activities', ['UserId'], { concurrently: true });
  },

  down: async queryInterface => {
    await queryInterface.removeIndex('Transactions', ['CreatedByUserId']);
    await queryInterface.removeIndex('Activities', ['UserId']);
  },
};
