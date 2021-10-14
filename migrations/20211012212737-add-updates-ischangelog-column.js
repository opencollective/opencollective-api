'use strict';

import { hasCompletedMigration, removeMigration } from './lib/helpers';
module.exports = {
  up: async (queryInterface, DataTypes) => {
    // Migration was renamed
    const scriptName = 'dev-20210602-add-updates-ischangelog-column.js';
    if (await hasCompletedMigration(queryInterface, scriptName)) {
      console.info(`Skipping execution of script as it's already executed: ${scriptName}`);
      await removeMigration(queryInterface, scriptName);
      return;
    }

    const [, result] = await queryInterface.sequelize.query(`
      SELECT name from "SequelizeMeta" WHERE name='${scriptName}';
    `);

    if (result.rowCount === 1) {
      console.info(`Skipping execution of script as it's already executed: ${scriptName}`);
      return;
    }

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
