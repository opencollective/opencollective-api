import type { QueryInterface } from 'sequelize';

import logger from '../server/lib/logger';

const CONSTRAINT_NAME = 'members_no_active_followers_check';

const hasConstraint = async (queryInterface: QueryInterface, transaction) => {
  const [constraints] = await queryInterface.sequelize.query(
    `SELECT 1 FROM pg_constraint WHERE conrelid = '"Members"'::regclass AND conname = :name`,
    { replacements: { name: CONSTRAINT_NAME }, transaction },
  );

  return constraints.length > 0;
};

module.exports = {
  async up(queryInterface: QueryInterface) {
    await queryInterface.sequelize.transaction(async transaction => {
      const constraintExists = await hasConstraint(queryInterface, transaction);
      if (!constraintExists) {
        // Install the write guard before cleanup so old app instances cannot recreate active followers.
        await queryInterface.sequelize.query(
          `ALTER TABLE "Members" ADD CONSTRAINT "${CONSTRAINT_NAME}" CHECK (role <> 'FOLLOWER' OR "deletedAt" IS NOT NULL) NOT VALID`,
          { transaction },
        );
      }

      await queryInterface.sequelize.query(
        `UPDATE "Members" SET "deletedAt" = NOW() WHERE role = 'FOLLOWER' AND "deletedAt" IS NULL`,
        { transaction },
      );

      const [activeFollowers] = await queryInterface.sequelize.query(
        `SELECT 1 FROM "Members" WHERE role = 'FOLLOWER' AND "deletedAt" IS NULL LIMIT 1`,
        { transaction },
      );
      if (activeFollowers.length) {
        throw new Error('Unable to retire all active follower memberships');
      }

      if (!constraintExists) {
        await queryInterface.sequelize.query(`ALTER TABLE "Members" VALIDATE CONSTRAINT "${CONSTRAINT_NAME}"`, {
          transaction,
        });
      }
    });
  },

  async down(queryInterface: QueryInterface) {
    await queryInterface.sequelize.query(`ALTER TABLE "Members" DROP CONSTRAINT IF EXISTS "${CONSTRAINT_NAME}"`);
    logger.info('The active-follower guard was removed; soft-deleted follower memberships were not restored');
  },
};
