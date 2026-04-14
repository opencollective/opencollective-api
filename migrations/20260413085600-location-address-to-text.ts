'use strict';

import type { QueryInterface } from 'sequelize';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface: QueryInterface, Sequelize) {
    await queryInterface.changeColumn('Locations', 'address', {
      type: Sequelize.TEXT,
      allowNull: true,
    });
  },

  async down(queryInterface: QueryInterface, Sequelize) {
    await queryInterface.changeColumn('Locations', 'address', {
      type: Sequelize.STRING,
      allowNull: true,
    });
  },
};
