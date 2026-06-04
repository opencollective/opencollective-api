'use strict';

import type { QueryInterface } from 'sequelize';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface: QueryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET data = jsonb_set(
        data - 'visibleToAccountIds',
        '{canBeUsedWithAccountIds}',
        data->'visibleToAccountIds'
      )
      WHERE type = 'VENDOR'
        AND data ? 'visibleToAccountIds'
    `);
  },

  async down(queryInterface: QueryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET data = jsonb_set(
        data - 'canBeUsedWithAccountIds',
        '{visibleToAccountIds}',
        data->'canBeUsedWithAccountIds'
      )
      WHERE type = 'VENDOR'
        AND data ? 'canBeUsedWithAccountIds'
    `);
  },
};
