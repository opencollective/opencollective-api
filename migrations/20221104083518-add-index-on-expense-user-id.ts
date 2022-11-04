'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.addIndex('Expenses', ['UserId'], {
      concurrently: true,
      where: { deletedAt: null },
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('Expenses', ['UserId']);
  },
};
