'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // Some transactions have a `null` JSON value for `data` (not a SQL NULL), which causes issues
    // when trying to update them. We need to set them to an empty object.
    let start = performance.now();
    const [, result] = await queryInterface.sequelize.query(`
      UPDATE "Transactions"
      SET "data" = NULL
      WHERE "data" = 'null'::jsonb
    `);
    console.log(`Updated ${result.rowCount} transactions with null data in ${Math.round(performance.now() - start)}ms`);

    // First pass: only update duplicates with `deletedAt` non-null. This will cover all cases from production.
    start = performance.now();
    const [, deletedDuplicates] = await queryInterface.sequelize.query(`
      WITH duplicates AS (
        SELECT uuid
        FROM "Transactions"
        GROUP BY uuid
        HAVING COUNT(*) > 1
      ) UPDATE "Transactions"
        SET
          "uuid" = gen_random_uuid(),
          "data" = JSONB_SET(COALESCE("data", '{}'), '{deduplicatedFromTransactionUuid}', TO_JSONB("Transactions"."uuid"::text))
        FROM duplicates
        WHERE "Transactions".uuid = duplicates.uuid
        AND "Transactions"."deletedAt" IS NOT NULL
    `);
    console.log(
      `Updated ${deletedDuplicates.rowCount} deleted duplicates in ${Math.round(performance.now() - start)}ms`,
    );

    // Second pass: update all non-deleted duplicates, for development and testing.
    start = performance.now();
    const [, regularDuplicates] = await queryInterface.sequelize.query(`
      WITH duplicates AS (
        SELECT uuid, MIN("id") AS "min_id"
        FROM "Transactions"
        GROUP BY uuid
        HAVING COUNT(*) > 1
      ) UPDATE "Transactions"
        SET
          "uuid" = gen_random_uuid(),
          "data" = JSONB_SET(COALESCE("data", '{}'), '{deduplicatedFromTransactionUuid}', TO_JSONB("Transactions"."uuid"::text))
        FROM duplicates
        WHERE "Transactions".uuid = duplicates.uuid
        AND "Transactions"."id" != duplicates."min_id"
    `);
    console.log(
      `Updated ${regularDuplicates.rowCount} non-deleted duplicates in ${Math.round(performance.now() - start)}ms`,
    );
  },

  async down() {
    console.log('No rollback possible');
  },
};
