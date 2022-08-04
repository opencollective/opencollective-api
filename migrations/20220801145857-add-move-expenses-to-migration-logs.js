'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      ALTER TYPE "enum_MigrationLogs_type"
      ADD VALUE IF NOT EXISTS 'MOVE_EXPENSES'
    `);
  },

  down: async queryInterface => {
    await queryInterface.sequelize.query(`
      ALTER TYPE "enum_MigrationLogs_type"
      DROP VALUE 'MOVE_EXPENSES'
    `);
  },
};
