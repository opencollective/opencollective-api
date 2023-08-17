'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  up: async queryInterface => {
    // Index all S3 hashes. This will be used to find duplicates.
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "UploadedFiles_s3_hash"
      ON "UploadedFiles"
      USING HASH (("data"->>'{s3SHA256}'::text))
      WHERE "data"->'s3SHA256' IS NOT NULL
    `);
  },

  down: async queryInterface => {
    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS "UploadedFiles_s3_hash"
    `);
  },
};
