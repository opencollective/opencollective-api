'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Reference accounting category from the `Orders` table
    await queryInterface.addColumn('OrderHistories', 'AccountingCategoryId', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });

    await queryInterface.addColumn('Orders', 'AccountingCategoryId', {
      type: Sequelize.INTEGER,
      references: { key: 'id', model: 'AccountingCategories' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    });

    // Add a kind column to accounting categories
    await queryInterface.addColumn('AccountingCategories', 'kind', {
      type: Sequelize.ENUM('ADDED_FUNDS', 'CONTRIBUTION', 'EXPENSE'),
      allowNull: true,
    });

    // Set default kind to expense, since we only had that until now
    await queryInterface.sequelize.query(`
      UPDATE "AccountingCategories"
      SET "kind" = 'EXPENSE'
      WHERE "kind" IS NULL
    `);
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('OrderHistories', 'AccountingCategoryId');
    await queryInterface.removeColumn('Orders', 'AccountingCategoryId');
    await queryInterface.removeColumn('AccountingCategories', 'kind');
  },
};
