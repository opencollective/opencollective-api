'use strict';

import type { QueryInterface } from 'sequelize';
import { DataTypes } from 'sequelize';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface: QueryInterface) {
    await queryInterface.removeColumn('Orders', 'privateMessage');
  },

  async down(queryInterface: QueryInterface) {
    await queryInterface.addColumn('Orders', 'privateMessage', {
      type: DataTypes.STRING,
      allowNull: true,
    });
  },
};
