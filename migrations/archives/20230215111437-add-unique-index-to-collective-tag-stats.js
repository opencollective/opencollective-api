'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.addIndex('CollectiveTagStats', ['HostCollectiveId', 'tag'], {
      unique: true,
      concurrently: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('CollectiveTagStats', ['HostCollectiveId', 'tag']);
  },
};
