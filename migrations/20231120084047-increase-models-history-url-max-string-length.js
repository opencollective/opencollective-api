'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.changeColumn('CollectiveHistories', 'image', {
      type: Sequelize.STRING(1200),
      allowNull: true,
    });
    await queryInterface.changeColumn('CollectiveHistories', 'backgroundImage', {
      type: Sequelize.STRING(1200),
      allowNull: true,
    });
  },

  async down() {
    console.log(
      'Not rolling back this migration because it would truncate the url column. Please do it manually if needed.',
    );
  },
};
