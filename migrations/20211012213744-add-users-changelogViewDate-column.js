'use strict';

module.exports = {
  up: async (queryInterface, DataTypes) => {
    const scriptName = 'dev-20210610-add-users-changelogViewDate-column.js';
    const [, result] = await queryInterface.sequelize.query(`
      SELECT name from "SequelizeMeta" WHERE name='${scriptName}';
    `);

    if (result.rowCount === 1) {
      console.info(`Skipping execution of script as it's already executed: ${scriptName}`);
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
