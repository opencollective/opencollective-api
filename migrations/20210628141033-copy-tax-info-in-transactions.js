'use strict';

module.exports = {
  up: async queryInterface => {
    await queryInterface.sequelize.query(`
      UPDATE "Transactions" t
      SET "data" = JSONB_SET(t."data", '{tax}', o."data" -> 'tax')
      FROM "Orders" o
      WHERE t."OrderId" = o.id
      AND o."data" ->> 'tax' IS NOT NULL
      AND t."data" ->> 'tax' IS NULL
      AND t."kind" = 'CONTRIBUTION'
    `);
  },

  down: async () => {
    // No need for rollback
  },
};
