'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      `UPDATE "Users" SET "emailWaitingForValidation" = NULL WHERE "emailWaitingForValidation" = "email"`,
    );
  },

  async down() {
    // No come back from this
    console.log('remove-already-validated-emails.js: No come back from this');
  },
};
