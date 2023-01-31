'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // Copy all IDs to the new standard field (took 40s against a local prod dump)
    await queryInterface.sequelize.query(`
      UPDATE "Transactions"
      SET "data" = JSONB_SET(
          "data",
          '{paypalCaptureId}',
          TO_JSON(
            COALESCE(
              "data" -> 'capture' ->> 'id',
              "data" -> 'paypalSale' ->> 'id',
              "data" -> 'paypalTransaction' ->> 'id'
            )::text
          )::jsonb
        )
      WHERE "data" ->> 'paypalCaptureId' IS NULL
      AND (
        "data" -> 'capture' ->> 'id' IS NOT NULL
        OR "data" -> 'paypalSale' ->> 'id' IS NOT NULL
        OR "data" -> 'paypalTransaction' ->> 'id' IS NOT NULL
      )
    `);

    // Create index
    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "transactions__data_paypal_capture_id"
      ON "Transactions"
      USING BTREE (("data"#>>'{paypalCaptureId}') ASC)
      WHERE "data"#>>'{paypalCaptureId}' IS NOT NULL
      AND "deletedAt" IS NULL
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      DROP INDEX CONCURRENTLY IF EXISTS "transactions__data_paypal_capture_id";
    `);
  },
};
