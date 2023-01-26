'use strict';
import { sanitizeTags } from '../server/lib/tags';

module.exports = {
  up: async queryInterface => {
    const collectives = await queryInterface.sequelize.query(
      `SELECT id, tags FROM "Collectives" WHERE tags IS NOT NULL`,
      { type: queryInterface.sequelize.QueryTypes.SELECT },
    );

    for (const collective of collectives) {
      const sanitizedTags = sanitizeTags(collective.tags);
      // Check if sanitized tags are different from the current tags
      if (JSON.stringify(sanitizedTags) !== JSON.stringify(collective.tags)) {
        await queryInterface.sequelize.query(
          `UPDATE "Collectives" SET tags = ${sanitizedTags ? `'{${sanitizedTags.join(',')}}'` : 'NULL'} WHERE id = :id`,
          {
            replacements: { id: collective.id },
          },
        );
      }
    }
  },

  down: async () => {
    // Can't rollback this migration
  },
};
