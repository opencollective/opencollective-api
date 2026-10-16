'use strict';

import type { QueryInterface } from 'sequelize';
import { DataTypes } from 'sequelize';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface: QueryInterface) {
    await queryInterface.removeColumn('Subscriptions', 'quantity');
  },

  async down(queryInterface: QueryInterface) {
    await queryInterface.addColumn('Subscriptions', 'quantity', {
      type: DataTypes.INTEGER,
      allowNull: true,
    });
  },
};
