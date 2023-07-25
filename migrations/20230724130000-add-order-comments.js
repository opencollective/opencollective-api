'use strict';

import { Op } from 'sequelize';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('Comments', 'OrderId', {
      type: Sequelize.INTEGER,
      references: {
        model: 'Orders',
        key: 'id',
      },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    });

    await queryInterface.addIndex('Comments', ['OrderId'], {
      concurrently: true,
      where: {
        OrderId: { [Op.ne]: null },
      },
    });

    await queryInterface.addColumn('CommentHistories', 'OrderId', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('Comments', ['OrderId']);
    queryInterface.removeColumn('Comments', 'OrderId');
    queryInterface.removeColumn('CommentHistories', 'OrderId');
  },
};
