'use strict';

/**
 * As of 2024-12-19, the database holds 24840 activities like:
 * - group.created
 * - group.expense.approved
 * - group.expense.created
 * - group.expense.paid
 * - group.expense.rejected
 * - group.expense.updated
 * - group.transaction.created
 * - group.transaction.paid
 * - group.user.added
 *
 * These types were renamed in migrations/archives/201707140000-GroupToCollective.js for Notifications, but
 * the activities were not migrated.
 *
 * @type {import('sequelize-cli').Migration}
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Activities"
      SET
        type = REPLACE(type, 'group.', 'collective.'),
        data = jsonb_set(COALESCE(data, '{}'), '{migratedFrom20241219102146}', '"true"')
      WHERE type like 'group.%'
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Activities"
      SET type = REPLACE(type, 'collective.', 'group.')
      WHERE type like 'collective.%'
      AND data->>'migratedFrom20241219102146' = 'true'
    `);
  },
};
