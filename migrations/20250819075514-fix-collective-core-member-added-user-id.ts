'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Activities"
      SET
        "UserId" = (data -> 'member' ->> 'CreatedByUserId')::integer,
        "data" = jsonb_set(data, '{migratedIn20250819}', 'true')
      WHERE type = 'collective.core.member.added'
      AND "UserId" IS NULL
      AND data -> 'member' ->> 'CreatedByUserId' IS NOT NULL
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Activities"
      SET
        "UserId" = NULL,
        "data" = jsonb_set(data, '{migratedIn20250819}', 'false')
      WHERE type = 'collective.core.member.added'
      AND data -> 'migratedIn20250819' = 'true'
    `);
  },
};
