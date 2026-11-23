'use strict';

import { QueryInterface } from 'sequelize';

/**
 * OpenSearch has been removed (opencollective/opencollective#9119). Its sync worker created these triggers at startup
 * (`setupPostgresTriggers` with the `notify_opensearch_on_change` function): drop them so that writes on these tables
 * stop sending notifications to a channel that nobody listens to anymore.
 */

const TABLES = [
  'Collectives',
  'Comments',
  'Expenses',
  'HostApplications',
  'Orders',
  'Tiers',
  'Transactions',
  'Updates',
];

module.exports = {
  async up(queryInterface: QueryInterface) {
    const dropTriggers = TABLES.map(tableName => {
      const triggerPrefix = `search_${tableName}`;
      return `
        DROP TRIGGER IF EXISTS ${triggerPrefix}_insert_trigger ON "${tableName}";
        DROP TRIGGER IF EXISTS ${triggerPrefix}_update_trigger ON "${tableName}";
        DROP TRIGGER IF EXISTS ${triggerPrefix}_delete_trigger ON "${tableName}";
      `;
    }).join('\n');

    await queryInterface.sequelize.transaction(async transaction => {
      // Dropping a trigger briefly locks its table: give up rather than queue behind long-running transactions
      await queryInterface.sequelize.query(`SET LOCAL lock_timeout = '10s'`, { transaction });
      await queryInterface.sequelize.query(dropTriggers, { transaction });
      await queryInterface.sequelize.query(`DROP FUNCTION IF EXISTS notify_opensearch_on_change()`, { transaction });
    });
  },

  async down() {
    // The triggers were created at runtime by the OpenSearch sync worker, which no longer exists
  },
};
