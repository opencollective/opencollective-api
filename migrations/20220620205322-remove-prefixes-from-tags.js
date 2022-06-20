'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      UPDATE "Collectives" SET tags = array(SELECT regexp_replace(array_to_string(tags,', '), '^#| #| ', '', 'g')) WHERE tags IS NOT NULL AND EXISTS(SELECT * FROM unnest(tags) tag WHERE tag ILIKE '#%');
    `);
  },

  down: async () => {
    // nop
  },
};
