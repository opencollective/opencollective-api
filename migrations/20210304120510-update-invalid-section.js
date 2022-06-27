'use strict';

import { moveSection, removeSection } from './lib/helpers';

/**
 * 1. Move transactions to the budget category
 * 2. Remove deprecated "connect" section
 */
module.exports = {
  up: async queryInterface => {
    // 1. Move transactions to the budget category (~750 entries)
    const [collectivesWithTransactionsSection] = await queryInterface.sequelize.query(`
      WITH entries AS (
        SELECT id, "type", settings, jsonb_array_elements(settings -> 'collectivePage' -> 'sections') AS sections
        FROM "Collectives" c 
        WHERE settings -> 'collectivePage' -> 'sections' IS NOT NULL
        AND jsonb_typeof(settings -> 'collectivePage' -> 'sections') != 'null'
      ) SELECT id, "type", settings
      FROM entries 
      WHERE sections ->> 'name' = 'transactions'
    `);

    for (const collective of collectivesWithTransactionsSection) {
      const newSettings = moveSection(collective.settings, 'transactions', 'BUDGET');
      if (newSettings !== collective.settings) {
        await queryInterface.sequelize.query(`UPDATE "Collectives" SET settings = :settings WHERE id = :id`, {
          replacements: { settings: JSON.stringify(newSettings), id: collective.id },
        });
      }
    }

    // 2. Remove deprecated "connect" section (~79 entries)
    const [collectivesWithConnectSection] = await queryInterface.sequelize.query(`
      WITH entries AS (
        SELECT id, "type", settings, jsonb_array_elements(settings -> 'collectivePage' -> 'sections') AS sections
        FROM "Collectives" c 
        WHERE settings -> 'collectivePage' -> 'sections' IS NOT NULL
        AND jsonb_typeof(settings -> 'collectivePage' -> 'sections') != 'null'
      ) SELECT id, "type", settings
      FROM entries 
      WHERE sections ->> 'name' = 'connect' AND sections ->> 'type' = 'SECTION'
    `);

    for (const collective of collectivesWithConnectSection) {
      const newSettings = removeSection(collective.settings, 'connect');
      if (newSettings !== collective.settings) {
        await queryInterface.sequelize.query(`UPDATE "Collectives" SET settings = :settings WHERE id = :id`, {
          replacements: { settings: JSON.stringify(newSettings), id: collective.id },
        });
      }
    }
  },

  down: async () => {
    // No rollback
  },
};
