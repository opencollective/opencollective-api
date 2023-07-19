'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.addIndex('Orders', ['CreatedByUserId'], {
      concurrently: true,
      where: { deletedAt: null },
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('Orders', ['CreatedByUserId']);
  },
};
