'use strict';

module.exports = {
  up: async function (queryInterface, DataTypes) {
    await queryInterface.addColumn('Users', 'passwordUpdatedAt', { type: DataTypes.DATE });
    await queryInterface.addColumn('UserHistories', 'passwordUpdatedAt', { type: DataTypes.DATE });
  },

  down: async function (queryInterface) {
    await queryInterface.removeColumn('UserHistories', 'passwordUpdatedAt');
    await queryInterface.removeColumn('Users', 'passwordUpdatedAt');
  },
};
