'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE EXTENSION IF NOT EXISTS pg_trgm;
    `);

    await queryInterface.sequelize.query(`
      create index concurrently if not exists "Orders_data_fromAccountInfo_name_search_idx"
      on "Orders" using gist(("data"->>'{fromAccountInfo,name}') gist_trgm_ops)
      include (
          description,
          tags,
          id,
          "SubscriptionId",
          "createdAt",
          "CollectiveId",
          "FromCollectiveId",
          "CreatedByUserId",
          "status",
          "TierId",
          "interval",
          "totalAmount",
          "currency",
          "PaymentMethodId",
          "deletedAt"
      );
    `);

    await queryInterface.sequelize.query(`
      create index concurrently if not exists "Orders_data_fromAccountInfo_email_search_idx"
      on "Orders" using gist(("data"->>'{fromAccountInfo,email}') gist_trgm_ops)
      include (
        description,
          tags,
          id,
          "SubscriptionId",
          "createdAt",
          "CollectiveId",
          "FromCollectiveId",
          "CreatedByUserId",
          "status",
          "TierId",
          "interval",
          "totalAmount",
          "currency",
          "PaymentMethodId",
          "deletedAt"
          );
    `);

    await queryInterface.sequelize.query(`
      create index concurrently if not exists "Orders_data_ponumber_search_idx"
      on "Orders" using gist((data->>'ponumber') gist_trgm_ops)
      include (
        description,
          tags,
          id,
          "SubscriptionId",
          "createdAt",
          "CollectiveId",
          "FromCollectiveId",
          "CreatedByUserId",
          "status",
          "TierId",
          "interval",
          "totalAmount",
          "currency",
          "PaymentMethodId",
          "deletedAt"
          );
      `);

    await queryInterface.sequelize.query(`
      create index concurrently if not exists "Orders_tags_search_idx"
      on "Orders" using gin(tags);
      `);

    await queryInterface.sequelize.query(`
      create index concurrently if not exists "Orders_description_search_idx"
      on "Orders" using gist(description gist_trgm_ops)
      include (
        description,
          tags,
          id,
          "SubscriptionId",
          "createdAt",
          "CollectiveId",
          "FromCollectiveId",
          "CreatedByUserId",
          "status",
          "TierId",
          "interval",
          "totalAmount",
          "currency",
          "PaymentMethodId",
          "deletedAt"
          );
      `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      drop index concurrently if exists "Orders_data_fromAccountInfo_name_search_idx";
    `);
    await queryInterface.sequelize.query(`
      drop index concurrently if exists "Orders_data_fromAccountInfo_email_search_idx";
    `);
    await queryInterface.sequelize.query(`
      drop index concurrently if exists "Orders_data_ponumber_search_idx";
    `);
    await queryInterface.sequelize.query(`
      drop index concurrently if exists "Orders_tags_search_idx";
    `);
    await queryInterface.sequelize.query(`
      drop index concurrently if exists "Orders_description_search_idx";
    `);
  },
};
