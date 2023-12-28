'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    const previousDomain = 'opencollective-production.s3-us-west-1.amazonaws.com';
    const newDomain = 'opencollective-production.s3.us-west-1.amazonaws.com';

    // Update uploaded files
    await queryInterface.sequelize.query(`
      UPDATE "UploadedFiles"
      SET "url" = replace("url", '${previousDomain}', '${newDomain}')
      WHERE "url" ILIKE '%${previousDomain}%'
    `);

    // Update collective images
    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET
        "image" = replace(image, '${previousDomain}', '${newDomain}'),
        "backgroundImage" = replace("backgroundImage", '${previousDomain}', '${newDomain}'),
        "longDescription" = replace("longDescription", '${previousDomain}', '${newDomain}')
      WHERE "image" ILIKE '%${previousDomain}%'
    `);

    // Update expense items
    await queryInterface.sequelize.query(`
      UPDATE "ExpenseItems"
      SET "url" = replace("url", '${previousDomain}', '${newDomain}')
      WHERE "url" ILIKE '%${previousDomain}%'
    `);

    // Update expense attachments
    await queryInterface.sequelize.query(`
      UPDATE "ExpenseAttachedFiles"
      SET "url" = replace("url", '${previousDomain}', '${newDomain}')
      WHERE "url" ILIKE '%${previousDomain}%'
    `);

    // Update Updates
    await queryInterface.sequelize.query(`
      UPDATE "Updates"
      SET "html" = replace("html", '${previousDomain}', '${newDomain}')
      WHERE "html" ILIKE '%${previousDomain}%'
    `);

    // Update comments
    await queryInterface.sequelize.query(`
      UPDATE "Comments"
      SET "html" = replace("html", '${previousDomain}', '${newDomain}')
      WHERE "html" ILIKE '%${previousDomain}%'
    `);

    // Update tiers
    await queryInterface.sequelize.query(`
      UPDATE "Tiers"
      SET "longDescription" = replace("longDescription", '${previousDomain}', '${newDomain}')
      WHERE "longDescription" ILIKE '%${previousDomain}%'
    `);
  },

  async down() {
    console.log('This migration cannot be rolled back.');
  },
};
