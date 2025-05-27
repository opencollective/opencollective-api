'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('ExpenseItems', 'order', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 0,
    });

    // Update existing items to have sequential order based on their ID
    await queryInterface.sequelize.query(`
      WITH ordered_items AS (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY "ExpenseId" ORDER BY "id" ASC) - 1 as row_num
        FROM "ExpenseItems"
      )
      UPDATE "ExpenseItems"
      SET "order" = ordered_items.row_num
      FROM ordered_items
      WHERE "ExpenseItems".id = ordered_items.id
    `);
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('ExpenseItems', 'order');
  },
};
