'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      UPDATE "Collectives" SET tags = array(SELECT regexp_replace(tag, '^#|', '', 'g')
        FROM unnest(tags) as tag)
        WHERE tags IS NOT NULL
          AND EXISTS(SELECT * FROM unnest(tags) tag WHERE tag ILIKE '#%');
    `);
  },

  down: async () => {
    // nop
  },
};
