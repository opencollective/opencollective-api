'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "LegalDocuments"
      SET "data" = "data" - 'helloWorksInstance'
      WHERE "data" ? 'helloWorksInstance'
    `);
  },

  async down() {
    console.log('No rollback possible, this migration was destructive');
  },
};
