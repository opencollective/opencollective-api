'use strict';

import { renameInJSONB } from './lib/helpers';

module.exports = {
  async up(queryInterface) {
    // Remove the disableGrantsByDefault flag as this is now the default behavior
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET "settings" = "settings" #- '{disableGrantsByDefault}'
      WHERE "settings" #> '{disableGrantsByDefault}' IS NOT NULL
    `);

    // Rename "hasGrant" to use expense type enum
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET "settings" = ${renameInJSONB('settings', ['expenseTypes', 'hasGrant'], ['expenseTypes', 'GRANT'])}
      WHERE "settings" #> '{expenseTypes,hasGrant}' IS NOT NULL
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET "settings" = ${renameInJSONB('settings', ['expenseTypes', 'GRANT'], ['expenseTypes', 'hasGrant'])}
      WHERE "settings" #> '{expenseTypes,GRANT}' IS NOT NULL
    `);
  },
};
