'use strict';

import { cloneDeep, update } from 'lodash';

import { stripHTML } from '../server/lib/sanitize-html';

module.exports = {
  up: async queryInterface => {
    const [collectives] = await queryInterface.sequelize.query(`
      SELECT id, "settings" FROM "Collectives" c 
      WHERE "settings" -> 'paymentMethods' -> 'manual' -> 'instructions' IS NOT NULL
      AND ("settings" -> 'paymentMethods' -> 'manual' -> 'instructions')::varchar LIKE '%<%'
    `);

    for (const collective of collectives) {
      const newSettings = cloneDeep(collective.settings);
      update(newSettings, 'paymentMethods.manual.instructions', stripHTML);
      await queryInterface.sequelize.query(`UPDATE "Collectives" SET settings = :settings WHERE id = :id`, {
        replacements: { settings: JSON.stringify(newSettings), id: collective.id },
      });
    }
  },

  down: async () => {
    // No rollback
  },
};
