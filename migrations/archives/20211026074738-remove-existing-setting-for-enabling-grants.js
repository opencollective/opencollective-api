'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      UPDATE "Collectives" SET settings = (settings::jsonb - 'fundingRequest')
        WHERE (settings->>'fundingRequest') IS NOT NULL;
    `);
  },

  down: async () => {
    // No rollback
  },
};
