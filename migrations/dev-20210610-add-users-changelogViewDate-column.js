'use strict';

module.exports = {
  up: async (queryInterface, DataTypes) => {
    await queryInterface.addColumn('Users', 'changelogViewDate', {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    });

    await queryInterface.addColumn('UserHistories', 'changelogViewDate', {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    });
  },

  down: async queryInterface => {
    await queryInterface.removeColumn('Users', 'changelogViewDate');
    await queryInterface.removeColumn('UserHistories', 'changelogViewDate');
  },
};
