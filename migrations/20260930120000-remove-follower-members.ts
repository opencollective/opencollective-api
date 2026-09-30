import type { QueryInterface } from 'sequelize';

import logger from '../server/lib/logger';

module.exports = {
  async up(queryInterface: QueryInterface) {
    // Permanently remove both active and soft-deleted follower memberships.
    await queryInterface.bulkDelete('Members', { role: 'FOLLOWER' });
  },

  async down() {
    logger.info('This migration is irreversible: deleted follower memberships cannot be restored');
  },
};
