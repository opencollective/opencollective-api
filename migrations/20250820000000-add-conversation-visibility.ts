'use strict';

module.exports = {
  up: async (queryInterface, DataTypes) => {
    await queryInterface.addColumn('Conversations', 'visibility', {
      type: DataTypes.ENUM('PUBLIC', 'ADMINS_AND_HOST'),
      defaultValue: 'PUBLIC',
      allowNull: false,
    });

    await queryInterface.addColumn('Conversations', 'HostCollectiveId', {
      type: DataTypes.INTEGER,
      references: { key: 'id', model: 'Collectives' },
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
      allowNull: true,
    });

    await queryInterface.sequelize.query(`
      UPDATE "Conversations" SET visibility = 'PUBLIC' WHERE visibility IS NULL
    `);

    await queryInterface.changeColumn('Conversations', 'visibility', {
      type: DataTypes.ENUM('PUBLIC', 'ADMINS_AND_HOST'),
      allowNull: false,
    });
  },

  down: async queryInterface => {
    await queryInterface.removeColumn('Conversations', 'visibility');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_Conversations_visibility"');
  },
};
