'use strict';

import { removeSection } from './lib/helpers';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // Remove deprecated "TRANSACTIONS" section for users (~1780 entries)
    const [collectivesWithTransactionsSection] = await queryInterface.sequelize.query(`
      WITH user_profiles_with_budget AS (
        SELECT c.id, c.settings, section -> 'sections' as budget_sections
        FROM "Collectives" c, jsonb_array_elements(settings -> 'collectivePage' -> 'sections') section
        WHERE c.type = 'USER'
        AND section ->> 'type' = 'CATEGORY'
        AND section ->> 'name' = 'BUDGET'
        AND "deletedAt" IS NULL
      ), user_profiles_with_transactions AS (
        SELECT id
        FROM user_profiles_with_budget, jsonb_array_elements(budget_sections) section
        WHERE section ->> 'type' = 'SECTION'
        AND section ->> 'name' = 'transactions'
      ) SELECT c.id, c.settings
      FROM user_profiles_with_transactions
      INNER JOIN "Collectives" c ON c.id = user_profiles_with_transactions.id
    `);

    for (const collective of collectivesWithTransactionsSection) {
      const newSettings = removeSection(collective.settings, 'transactions', 'BUDGET');
      if (newSettings !== collective.settings) {
        await queryInterface.sequelize.query(`UPDATE "Collectives" SET settings = :settings WHERE id = :id`, {
          replacements: { settings: JSON.stringify(newSettings), id: collective.id },
        });
      }
    }
  },

  async down() {
    console.log('No rollback');
  },
};
