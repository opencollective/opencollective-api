'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(
      `UPDATE "Tiers" SET "minimumAmount" = NULL, "presets" = NULL WHERE "amountType" = 'FIXED'`,
    );
  },

  down: async () => {
    // No rollback
  },
};
