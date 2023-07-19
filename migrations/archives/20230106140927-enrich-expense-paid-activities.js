'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Activities" a
      SET
        "TransactionId" = (a."data" #>> '{transaction, id}')::integer,
        "data" = jsonb_set(a."data", '{migration-20230106140927}', 'true')
      FROM "Transactions" t
      WHERE a."type" = 'collective.expense.paid'
      AND a."TransactionId" IS NULL
      AND a."data" #>> '{transaction, id}' IS NOT NULL
      AND (a."data" #>> '{transaction, id}')::integer = t.id
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Activities"
      SET "TransactionId" = NULL
      WHERE "type" = 'collective.expense.paid'
      AND "TransactionId" IS NOT NULL
      AND "data" #>> '{transaction, id}' IS NOT NULL
    `);
  },
};
