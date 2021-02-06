'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Enhance User.prototype.getIncognitoProfile() performance
    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS CreatedByUserId ON "public"."Collectives"("CreatedByUserId");
    `);
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.removeIndex('Collectives', 'CreatedByUserId');
  },
};
