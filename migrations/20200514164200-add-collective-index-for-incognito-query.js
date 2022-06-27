'use strict';

module.exports = {
  up: async queryInterface => {
    // Enhance User.prototype.getIncognitoProfile() performance
    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS CreatedByUserId ON "public"."Collectives"("CreatedByUserId");
    `);
  },

  down: async queryInterface => {
    await queryInterface.removeIndex('Collectives', 'CreatedByUserId');
  },
};
