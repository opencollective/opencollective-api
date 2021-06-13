'use strict';

module.exports = {
  up: async (queryInterface, DataTypes) => {
    await queryInterface.addColumn('Updates', 'isChangelog', {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      allowNull: false,
    });

    await queryInterface.addColumn('UpdateHistories', 'isChangelog', {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      allowNull: false,
    });
  },

  down: async queryInterface => {
    await queryInterface.removeColumn('Updates', 'isChangelog');
    await queryInterface.removeColumn('UpdateHistories', 'isChangelog');
  },
};
