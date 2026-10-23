import type { QueryInterface } from 'sequelize';

module.exports = {
  async up(queryInterface: QueryInterface) {
    await queryInterface.sequelize.query(
      `UPDATE "Members" SET "deletedAt" = NOW() WHERE role = 'FOLLOWER' AND "deletedAt" IS NULL`,
    );
  },

  async down() {},
};
