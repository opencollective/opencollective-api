'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // Divide executionTime by 1000 x 1000 as it was wrongly multiplied by 1000 instead of divided
    await queryInterface.sequelize.query(`
      UPDATE "UploadedFiles"
      SET "data" = JSONB_SET(
        "data",
        '{ocrData,executionTime}',
        (("data"->'ocrData'->>'executionTime')::float / 1000 / 1000)::text::jsonb
      )
      WHERE "data"->'ocrData'->'executionTime' IS NOT NULL
    `);
  },

  async down(queryInterface) {
    // Multiply executionTime by 1000 x 1000 as it was wrongly divided by 1000 instead of multiplied
    await queryInterface.sequelize.query(`
      UPDATE "UploadedFiles"
      SET "data" = JSONB_SET(
        "data",
        '{ocrData,executionTime}',
        (("data"->'ocrData'->>'executionTime')::float * 1000 * 1000)::text::jsonb
      )
      WHERE "data"->'ocrData'->'executionTime' IS NOT NULL
    `);
  },
};
