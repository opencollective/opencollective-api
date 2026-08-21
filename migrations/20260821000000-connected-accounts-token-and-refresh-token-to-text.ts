'use strict';

import type { QueryInterface } from 'sequelize';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface: QueryInterface, Sequelize) {
    await queryInterface.changeColumn('ConnectedAccounts', 'token', {
      type: Sequelize.TEXT,
      allowNull: true,
    });

    await queryInterface.changeColumn('ConnectedAccounts', 'refreshToken', {
      type: Sequelize.TEXT,
      allowNull: true,
    });
  },

  async down() {
    // Cannot be reverted because changing the column type back to STRING may cause data loss if the existing data exceeds the maximum length of STRING.
  },
};
