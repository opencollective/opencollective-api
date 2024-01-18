'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    // Add UserId and isSystem to order.new.pendingFinancialContribution
    await queryInterface.sequelize.query(`
      UPDATE "Activities"
      SET "UserId" = o."CreatedByUserId", "data" = jsonb_set("Activities"."data", '{isSystem}', 'true')
      FROM "Orders" o
      WHERE "Activities"."OrderId" = o.id
      AND "Activities"."type" = 'order.new.pendingFinancialContribution'
    `);

    // Add isSystem to order.reminder.pendingFinancialContribution
    await queryInterface.sequelize.query(`
      UPDATE "Activities"
      SET "data" = jsonb_set("data", '{isSystem}', 'true')
      WHERE "type" = 'order.reminder.pendingFinancialContribution'
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      UPDATE "Activities"
      SET "UserId" = NULL, "data" = "data" - 'isSystem'
      WHERE "type" = 'order.new.pendingFinancialContribution'
    `);

    await queryInterface.sequelize.query(`
      UPDATE "Activities"
      SET "data" = "data" - 'isSystem'
      WHERE "type" = 'order.reminder.pendingFinancialContribution'
    `);
  },
};
