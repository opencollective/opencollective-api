'use strict';

import { Op } from 'sequelize';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.addIndex('Activities', ['OrderId'], {
      concurrently: true,
      where: {
        OrderId: { [Op.ne]: null },
      },
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('Activities', ['OrderId']);
  },
};
