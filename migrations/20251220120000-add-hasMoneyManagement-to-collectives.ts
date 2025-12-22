'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('CollectiveHistories', 'hasMoneyManagement', {
      type: Sequelize.BOOLEAN,
      allowNull: true,
    });

    await queryInterface.addColumn('Collectives', 'hasMoneyManagement', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });

    await queryInterface.sequelize.query(`
      UPDATE "CollectiveHistories"
      SET "hasMoneyManagement" = "isHostAccount"
    `);

    await queryInterface.sequelize.query(`
      UPDATE "Collectives"
      SET "hasMoneyManagement" = "isHostAccount"
    `);
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Collectives', 'hasMoneyManagement');
    await queryInterface.removeColumn('CollectiveHistories', 'hasMoneyManagement');
  },
};
