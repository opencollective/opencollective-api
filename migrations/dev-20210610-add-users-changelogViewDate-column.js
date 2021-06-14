'use strict';

module.exports = {
  up: async (queryInterface, DataTypes) => {
    await queryInterface.addColumn('Users', 'changelogViewDate', {
      type: DataTypes.DATE,
    });

    await queryInterface.addColumn('UserHistories', 'changelogViewDate', {
      type: DataTypes.DATE,
    });
  },

  down: async queryInterface => {
    await queryInterface.removeColumn('Users', 'changelogViewDate');
    await queryInterface.removeColumn('UserHistories', 'changelogViewDate');
  },
};
