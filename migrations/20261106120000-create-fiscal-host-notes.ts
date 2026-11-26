import { DataTypes, QueryInterface } from 'sequelize';

module.exports = {
  async up(queryInterface: QueryInterface) {
    await queryInterface.sequelize.transaction(async transaction => {
      await queryInterface.createTable(
        'FiscalHostNotes',
        {
          id: {
            type: DataTypes.INTEGER,
            primaryKey: true,
            autoIncrement: true,
          },
          type: {
            type: DataTypes.STRING,
            allowNull: false,
          },
          note: {
            type: DataTypes.TEXT,
            allowNull: false,
          },
          HostCollectiveId: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: { model: 'Collectives', key: 'id' },
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE',
          },
          CollectiveId: {
            type: DataTypes.INTEGER,
            allowNull: false,
            references: { model: 'Collectives', key: 'id' },
            onDelete: 'CASCADE',
            onUpdate: 'CASCADE',
          },
          CreatedByUserId: {
            type: DataTypes.INTEGER,
            allowNull: true,
            references: { model: 'Users', key: 'id' },
            onDelete: 'SET NULL',
            onUpdate: 'CASCADE',
          },
          UpdatedByUserId: {
            type: DataTypes.INTEGER,
            allowNull: true,
            references: { model: 'Users', key: 'id' },
            onDelete: 'SET NULL',
            onUpdate: 'CASCADE',
          },
          createdAt: {
            type: DataTypes.DATE,
            allowNull: false,
            defaultValue: DataTypes.NOW,
          },
          updatedAt: {
            type: DataTypes.DATE,
            allowNull: false,
            defaultValue: DataTypes.NOW,
          },
        },
        { transaction },
      );

      await queryInterface.addConstraint('FiscalHostNotes', {
        fields: ['HostCollectiveId', 'CollectiveId'],
        type: 'unique',
        name: 'fiscal_host_notes_host_account_unique',
        transaction,
      });
    });
  },

  async down(queryInterface: QueryInterface) {
    await queryInterface.dropTable('FiscalHostNotes');
  },
};
