'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Add index on Activity > CollectiveId
    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS activities__collective_id ON public."Activities" USING btree ("CollectiveId")
    `);

    // Create Activity > ExpenseId, add an index and fill column
    await queryInterface.addColumn('Activities', 'ExpenseId', {
      type: Sequelize.INTEGER,
      references: { key: 'id', model: 'Expenses' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    });

    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS activities__expense_id ON public."Activities" USING btree ("ExpenseId")
    `);

    await queryInterface.sequelize.query(`
      UPDATE "Activities"
      SET "ExpenseId" = ("data" -> 'expense' ->> 'id')::int
      WHERE "data" -> 'expense' ->> 'id' IS NOT NULL
    `);
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.removeIndex('Activities', 'activities__collective_id');
    await queryInterface.removeIndex('Activities', 'activities__expense_id');
    await queryInterface.removeColumn('Activities', 'ExpenseId');
  },
};
