'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('Expenses', 'tags', {
      type: Sequelize.ARRAY(Sequelize.STRING),
    });
    await queryInterface.addColumn('ExpenseHistories', 'tags', {
      type: Sequelize.ARRAY(Sequelize.STRING),
    });

    await queryInterface.sequelize.query(`
      UPDATE "Expenses"
      SET tags = (
        CASE WHEN "category" IS NULL THEN NULL
        ELSE ARRAY[UPPER("category")]
        END
      );  
    `);

    await queryInterface.sequelize.query(`
      UPDATE "ExpenseHistories"
      SET tags = (
        CASE WHEN "category" IS NULL THEN NULL
        ELSE ARRAY[UPPER("category")]
        END
      );  
    `);

    await queryInterface.removeColumn('Expenses', 'category');
    await queryInterface.removeColumn('ExpenseHistories', 'category');
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('Expenses', 'category', {
      type: Sequelize.STRING,
    });
    await queryInterface.addColumn('ExpenseHistories', 'category', {
      type: Sequelize.STRING,
    });

    await queryInterface.sequelize.query(`
      UPDATE "Expenses"
      SET category = initcap(tags[1]);
    `);
    await queryInterface.sequelize.query(`
      UPDATE "ExpenseHistories"
      SET category = initcap(tags[1]);
    `);

    await queryInterface.removeColumn('Expenses', 'tags');
    await queryInterface.removeColumn('ExpenseHistories', 'tags');
  },
};
