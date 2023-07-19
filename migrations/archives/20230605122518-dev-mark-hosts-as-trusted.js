'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    if (!['production', 'test'].includes(process.env.OC_ENV)) {
      await queryInterface.sequelize.query(`
        UPDATE "Collectives"
        SET "data" = jsonb_set("data", '{isTrustedHost}', 'true')
        WHERE slug IN (
          'brusselstogetherasbl',
          'opensource'
        )
     `);
    }
  },

  async down() {
    // No rollback
  },
};
