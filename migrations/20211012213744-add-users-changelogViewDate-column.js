'use strict';

import { hasCompletedMigration, removeMigration } from './lib/helpers';
module.exports = {
  up: async (queryInterface, DataTypes) => {
    // Migration was renamed
    const scriptName = 'dev-20210610-add-users-changelogViewDate-column.js';
    if (await hasCompletedMigration(queryInterface, scriptName)) {
      console.info(`Skipping execution of script as it's already executed: ${scriptName}`);
      await removeMigration(queryInterface, scriptName);
      return;
    }

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
