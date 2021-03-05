'use strict';

module.exports = {
  up: async queryInterface => {
    // create temp table
    await queryInterface.sequelize.query(
      `CREATE TEMPORARY TABLE "tmp_invalid_order_subscriptions" AS
    SELECT "Orders"."id" as "order_id", "Subscriptions".id as "sub_id", "Subscriptions".amount as "sub_amount", "Orders"."totalAmount" as "order_amount",  "Tiers".amount as "fixed_tier_amount", (COALESCE((("Orders".data ->> 'platformFee')::int), 0)) as "platform_fee" FROM "Orders"
    INNER JOIN "Subscriptions" ON "Orders"."SubscriptionId" = "Subscriptions".id
    INNER JOIN "Tiers" ON "Orders"."TierId"="Tiers".id
    WHERE ("Orders"."status" = 'ACTIVE') AND ("Subscriptions"."isActive" = true) AND ("Orders"."totalAmount" != "Subscriptions".amount) AND ("Orders"."totalAmount" != "Tiers".amount) AND ("Orders"."TierId" IS NOT NULL) AND ("Tiers"."amountType" = 'FIXED');
    `,
    );

    // check the number of orders to alter and log the info
    const [orders] = await queryInterface.sequelize.query(`
  SELECT * FROM "tmp_invalid_order_subscriptions";
  `);

    console.info(`Found ${orders.length} Orders that require migration`);

    for (const order of orders) {
      console.info(
        ` -> Order id: ${order.order_id}, Subscription id: ${order.sub_id}, Subscription amount: ${order.sub_amount}, Order totalAmount: ${order.order_amount}, Tier fixed amount: ${order.fixed_tier_amount}, Platform fee: ${order.platform_fee}`,
      );
    }

    // update the Order and Subscription tables and delete the temporary table
    await queryInterface.sequelize.query(
      `
    BEGIN;

    UPDATE "Orders" o
    SET "totalAmount" = t.fixed_tier_amount + platform_fee
    FROM "tmp_invalid_order_subscriptions" t
    WHERE (o.id = t.order_id);

    UPDATE "Subscriptions" s
    SET "amount" = t.fixed_tier_amount + platform_fee
    FROM "tmp_invalid_order_subscriptions" t
    WHERE (s.id = t.sub_id);

    DROP TABLE "tmp_invalid_order_subscriptions";

   COMMIT;
    `,
    );
  },

  down: async () => {
    // No rollback
  },
};
