'use strict';

import type { QueryInterface } from 'sequelize';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface: QueryInterface, Sequelize) {
    await queryInterface.addColumn('CollectiveHistories', 'isPrivate', {
      type: Sequelize.BOOLEAN,
      allowNull: true, // nullable in history table for backward compat
      defaultValue: false,
    });

    await queryInterface.addColumn('Collectives', 'isPrivate', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
  },

  async down(queryInterface: QueryInterface) {
    await queryInterface.removeColumn('Collectives', 'isPrivate');
    await queryInterface.removeColumn('CollectiveHistories', 'isPrivate');
  },
};
