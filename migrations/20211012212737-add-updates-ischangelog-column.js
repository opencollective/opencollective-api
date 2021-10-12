'use strict';

module.exports = {
  up: async (queryInterface, DataTypes) => {
    const scriptName = 'dev-20210602-add-updates-ischangelog-column.js';
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
