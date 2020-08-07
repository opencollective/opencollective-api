'use strict';

module.exports = {
  /**
   * Set "Collectives" -> "data" -> "useCustomHostFee" to true when their hostFeePercent
   * is different from the one of the host.
   */
  up: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.query(`
      UPDATE ONLY "Collectives" c
      SET
        data = (
          CASE WHEN c.data IS NULL 
          THEN '{"useCustomHostFee": true}'::jsonb
          ELSE c.data::jsonb || '{"useCustomHostFee": true}'::jsonb
        END)
      FROM  "Collectives" host
      WHERE c."HostCollectiveId" = host.id
      AND   c."approvedAt" IS NOT NULL
      AND   c."deletedAt" IS NULL
      AND   c."hostFeePercent" IS NOT NULL
      AND   c."hostFeePercent" != host."hostFeePercent"
      AND   host."deletedAt" IS NULL
    `);
  },

  down: async (queryInterface, Sequelize) => {
    /**
     * No rollback
     */
  },
};
