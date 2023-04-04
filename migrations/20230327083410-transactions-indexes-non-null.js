'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // For UsingGiftCardFromCollectiveId
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS public.transactions__using_gift_card_from_collective_id;
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY transactions__using_gift_card_from_collective_id
      ON public."Transactions" ("UsingGiftCardFromCollectiveId")
      WHERE ("deletedAt" IS NULL);
    `);

    // For TransactionGroup
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS public.transactions__transaction_group;
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY transactions__transaction_group
      ON public."Transactions" ("TransactionGroup")
      WHERE ("deletedAt" IS NULL);
    `);

    // For CreatedByUserId
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS public.transactions__created_by_user_id;
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY transactions__created_by_user_id
      ON public."Transactions" ("CreatedByUserId")
      WHERE ("deletedAt" IS NULL);
    `);

    // For OrderId
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS public."DonationId";
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY transactions__order_id
      ON public."Transactions" ("OrderId")
      WHERE ("deletedAt" IS NULL);
    `);
  },

  async down(queryInterface) {
    // For UsingGiftCardFromCollectiveId
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS public.transactions__using_gift_card_from_collective_id;
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY transactions__using_gift_card_from_collective_id
      ON public."Transactions" ("UsingGiftCardFromCollectiveId");
    `);

    // For TransactionGroup
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS public.transactions__transaction_group;
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY transactions__transaction_group
      ON public."Transactions" ("TransactionGroup");
    `);

    // For CreatedByUserId
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS public.transactions__created_by_user_id;
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY transactions__created_by_user_id
      ON public."Transactions" ("CreatedByUserId");
    `);

    // For OrderId
    await queryInterface.sequelize.query(`
      DROP INDEX IF EXISTS public.transactions__order_id
    `);

    await queryInterface.sequelize.query(`
      CREATE INDEX CONCURRENTLY "DonationId"
      ON public."Transactions" ("OrderId");
    `);
  },
};
