'use strict';

/**
 * Renames the legacy `Notifications` table to `ActivitySubscriptions` to match
 * the ActivitySubscription Sequelize model (`server/models/ActivitySubscription.ts`).
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.renameTable('Notifications', 'ActivitySubscriptions');
  },

  async down(queryInterface) {
    await queryInterface.renameTable('ActivitySubscriptions', 'Notifications');
  },
};
