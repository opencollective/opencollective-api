'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    if (['development', 'e2e', 'ci'].includes(process.env.OC_ENV) || process.env.E2E_TEST) {
      await queryInterface.sequelize.query(`
        UPDATE "Transactions" SET "publicId" = oc_nanoid('tx')
        WHERE "publicId" IS NULL;
      `);

      await queryInterface.sequelize.query(`
        ALTER TABLE "Transactions" ALTER COLUMN "publicId" SET NOT NULL;
      `);
    }
  },

  async down() {},
};
