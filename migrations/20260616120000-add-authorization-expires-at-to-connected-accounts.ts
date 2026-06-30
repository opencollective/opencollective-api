'use strict';

import type { DataTypes, QueryInterface } from 'sequelize';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface: QueryInterface, Sequelize: typeof DataTypes) {
    await queryInterface.addColumn('ConnectedAccounts', 'authorizationExpiresAt', {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },

  async down(queryInterface: QueryInterface) {
    await queryInterface.removeColumn('ConnectedAccounts', 'authorizationExpiresAt');
  },
};
