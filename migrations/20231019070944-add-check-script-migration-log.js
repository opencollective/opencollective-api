'use strict';

import { updateEnum } from './lib/helpers';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      ALTER TYPE "enum_MigrationLogs_type"
      ADD VALUE IF NOT EXISTS 'MODEL_FIX'
    `);
  },

  down: async queryInterface => {
    // Restore previous enum values
    await updateEnum(
      queryInterface,
      'MigrationLogs',
      'type',
      'enum_MigrationLogs_type',
      ['MIGRATION', 'MANUAL', 'MERGE_ACCOUNTS', 'BAN_ACCOUNTS', 'MOVE_ORDERS', 'MOVE_EXPENSES'],
      { isArray: false },
    );
  },
};
