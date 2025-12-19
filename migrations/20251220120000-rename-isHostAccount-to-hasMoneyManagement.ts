'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.renameColumn('Collectives', 'isHostAccount', 'hasMoneyManagement');
    await queryInterface.renameColumn('CollectiveHistories', 'isHostAccount', 'hasMoneyManagement');
  },

  async down(queryInterface) {
    await queryInterface.renameColumn('Collectives', 'hasMoneyManagement', 'isHostAccount');
    await queryInterface.renameColumn('CollectiveHistories', 'hasMoneyManagement', 'isHostAccount');
  },
};
