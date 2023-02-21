'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    queryInterface.sequelize.query(`
      UPDATE "Tiers"
      SET currency = "affectedTier"."collectiveCurrency"
      FROM (
        select t.id as "TierId", c.currency as "collectiveCurrency"
        from "Tiers" t inner join "Collectives" c on c.id = t."CollectiveId" 
        where t.currency <> c.currency and t."deletedAt" is null and t."createdAt" >= '2023-02-07'
      ) AS "affectedTier"
      WHERE "Tiers".id = "affectedTier"."TierId";
    `);
  },

  async down() {
    // no rollback
  },
};
