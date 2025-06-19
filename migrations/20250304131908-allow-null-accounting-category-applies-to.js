'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Change the appliesTo column to allow NULL values
    await queryInterface.changeColumn('AccountingCategories', 'appliesTo', {
      type: Sequelize.ENUM(['HOST', 'HOSTED_COLLECTIVES']),
      allowNull: true,
      defaultValue: null,
    });
  },

  async down(queryInterface, Sequelize) {
    // Revert the column back to NOT NULL with default value
    await queryInterface.changeColumn('AccountingCategories', 'appliesTo', {
      type: Sequelize.ENUM(['HOST', 'HOSTED_COLLECTIVES']),
      allowNull: false,
      defaultValue: 'HOSTED_COLLECTIVES',
    });
  },
};
