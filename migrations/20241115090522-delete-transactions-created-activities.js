'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      DELETE FROM "Activities"
      WHERE "type" = 'collective.transaction.created'
    `);
  },

  async down() {
    console.log('This migration is irreversible, but a backup has been made.');
  },
};
