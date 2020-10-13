'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.sequelize.query(
      `CREATE TEMPORARY TABLE "tmp_invalid_order_subscriptions" AS
	  SELECT "Orders"."id" as "order_id", "Subscriptions".id as "sub_id", "Subscriptions".amount as "sub_amount", "Orders"."totalAmount" as "order_amount",  "Tiers".amount as "fixed_tier_amount", (COALESCE((("Orders".data ->> 'platformFee')::int), 0)) as "platform_fee" FROM "Orders"
	  INNER JOIN "Subscriptions" ON "Orders"."SubscriptionId" = "Subscriptions".id
	  INNER JOIN "Tiers" ON "Orders"."TierId"="Tiers".id
	  WHERE ("Orders"."status" = 'ACTIVE') AND ("Subscriptions"."isActive" = true) AND ("Orders"."totalAmount" != "Subscriptions".amount) AND ("Orders"."totalAmount" != "Tiers".amount) AND ("Orders"."TierId" IS NOT NULL) AND ("Tiers"."amountType" = 'FIXED');
	  
	  UPDATE "Orders" o
	  SET "totalAmount" = t.fixed_tier_amount + platform_fee
	  FROM "tmp_invalid_order_subscriptions" t
	  WHERE (o.id = t.order_id);
	  
	  UPDATE "Subscriptions" s
	  SET "amount" = t.fixed_tier_amount + platform_fee
	  FROM "tmp_invalid_order_subscriptions" t
	  WHERE (s.id = t.sub_id);
	  
	  DROP TABLE "tmp_invalid_order_subscriptions";`,
    );
  },

  down: async (queryInterface, Sequelize) => {},
};
