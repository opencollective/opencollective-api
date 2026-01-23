'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // Delete all MigrationLog entries with type MOVE_EXPENSES created after August 4, 2022
    await queryInterface.sequelize.query(`
      DELETE FROM "MigrationLogs"
      WHERE type = 'MOVE_EXPENSES'
      AND "createdAt" > '2022-08-04 23:59:59.999Z'
    `);
  },

  async down() {
    // This operation cannot be reversed as the data is permanently deleted
    console.log('Cannot rollback: deleted MigrationLog entries cannot be restored');
  },
};
