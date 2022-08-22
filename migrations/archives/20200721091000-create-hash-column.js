'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('ConnectedAccounts', 'hash', { type: Sequelize.STRING });
  },

  down: async queryInterface => {
    await queryInterface.removeColumn('ConnectedAccounts', 'hash');
  },
};
