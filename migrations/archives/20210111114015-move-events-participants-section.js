'use strict';

import { cloneDeep, remove } from 'lodash';

module.exports = {
  up: async queryInterface => {
    const [collectives] = await queryInterface.sequelize.query(`
      WITH entries AS (
        SELECT id, "type", settings, jsonb_array_elements(settings -> 'collectivePage' -> 'sections') AS sections
        FROM "Collectives" c
        WHERE settings -> 'collectivePage' -> 'sections' IS NOT NULL
        AND c."type" = 'EVENT'
        AND (settings -> 'collectivePage' ->> 'useNewSections')::boolean IS TRUE
      ) SELECT id, "type", settings
      FROM entries
      WHERE sections ->> 'name' = 'participants'
    `);

    for (const collective of collectives) {
      const settings = cloneDeep(collective.settings);
      const { sections } = settings.collectivePage;
      if (!sections) {
        continue;
      }

      const [section] = remove(sections, s => s.name === 'participants');
      const category = sections.find(s => s.type === 'CATEGORY' && s.name === 'CONTRIBUTE');
      if (section && category?.sections && !category.sections.find(s => s.name === 'participants')) {
        category.sections.push(section);
      }

      await queryInterface.sequelize.query(`UPDATE "Collectives" SET settings = :settings WHERE id = :id`, {
        replacements: { settings: JSON.stringify(settings), id: collective.id },
      });
    }
  },

  down: async () => {
    // No rollback
  },
};
