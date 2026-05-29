'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "UploadedFiles_s3_hash"`);
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY "UploadedFiles_s3_hash"
      ON public."UploadedFiles" ((data #>> '{s3SHA256}'))
      WHERE "deletedAt" IS NULL AND data #>> '{s3SHA256}' IS NOT NULL
    `);
  },

  async down() {
    console.log("Not bringing back the old index since it wasn't working with the new query");
  },
};
