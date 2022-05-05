'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    /**
     * Add altering commands here.
     *
     * Example:
     * await queryInterface.createTable('users', { id: Sequelize.INTEGER });
     */
    queryInterface
      .addColumn(
        'Collectives', // table name
        'isFrozen', // new field name
        {
          type: Sequelize.BOOLEAN,
          allowNull: true,
        },
      )
      .then(() =>
        queryInterface.addColumn('CollectiveHistories', 'isFrozen', {
          type: Sequelize.BOOLEAN,
        }),
      );
  },

  async down(queryInterface, Sequelize) {
    /**
     * Add reverting commands here.
     *
     * Example:
     * await queryInterface.dropTable('users');
     */
    queryInterface
      .removeColumn(
        'Collectives', // table name
        'isFrozen', // new field name
      )
      .then(() =>
        queryInterface.removeColumn('CollectiveHistories', 'isFrozen', {
          type: Sequelize.BOOLEAN,
        }),
      );
  },
};
