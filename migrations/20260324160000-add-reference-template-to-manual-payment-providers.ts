'use strict';

import type { QueryInterface } from 'sequelize';
import { DataTypes } from 'sequelize';

module.exports = {
  async up(queryInterface: QueryInterface) {
    await queryInterface.addColumn('ManualPaymentProviders', 'referenceTemplate', {
      type: DataTypes.TEXT,
      allowNull: true,
    });
  },

  async down(queryInterface: QueryInterface) {
    await queryInterface.removeColumn('ManualPaymentProviders', 'referenceTemplate');
  },
};
