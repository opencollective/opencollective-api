'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('AccountingCategories', 'hostOnly', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });

    await queryInterface.addColumn('AccountingCategories', 'instructions', {
      type: Sequelize.TEXT,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('AccountingCategories', 'hostOnly');
    await queryInterface.removeColumn('AccountingCategories', 'instructions');
  },
};
