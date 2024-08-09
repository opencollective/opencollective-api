'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "LegalDocuments"
      SET "requestStatus" = 'ERROR',
          "data" = jsonb_set("data", '{error}', '"Sunsetting Dropbox Forms: request expired"')
      WHERE service = 'DROPBOX_FORMS'
      AND "requestStatus" = 'REQUESTED'
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "LegalDocuments"
      SET "requestStatus" = 'REQUESTED',
          "data" = "data" #- '{error}'
      WHERE service = 'DROPBOX_FORMS'
      AND "requestStatus" = 'ERROR'
      AND "data" ->> 'error' = 'Sunsetting Dropbox Forms: request expired'
    `);
  },
};
