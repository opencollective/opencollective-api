'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Activities"
      SET "UserId" = (data -> 'member' -> 'CreatedByUserId')::integer
      WHERE type = 'collective.member.created'
      AND data -> 'member' -> 'CreatedByUserId' IS NOT NULL
    `);
  },

  async down() {
    // No come back from this
  },
};
