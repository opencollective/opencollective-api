'use strict';

import logger from '../server/lib/logger';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET "settings" = "settings" - 'crowdfundingRedesign'
      WHERE "settings" ? 'crowdfundingRedesign'
      AND "deletedAt" IS NULL
    `);
  },

  async down() {
    logger.info('This migration is irreversible');
  },
};
