'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.addIndex('ConnectedAccounts', ['CollectiveId'], {
      concurrently: true,
      where: { deletedAt: null },
    });

    await queryInterface.addIndex('Conversations', ['CollectiveId'], {
      concurrently: true,
      where: { deletedAt: null },
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('ConnectedAccounts', ['CollectiveId']);
    await queryInterface.removeIndex('Conversations', ['CollectiveId']);
  },
};
