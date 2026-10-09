import { DataTypes, QueryInterface } from 'sequelize';

module.exports = {
  async up(queryInterface: QueryInterface) {
    await queryInterface.sequelize.transaction(async transaction => {
      await queryInterface.addColumn(
        'PayoutMethods',
        'ConnectedAccountId',
        {
          type: DataTypes.INTEGER,
          allowNull: true,
          references: { model: 'ConnectedAccounts', key: 'id' },
          onDelete: 'SET NULL',
          onUpdate: 'CASCADE',
        },
        { transaction },
      );

      // Include archived payout methods and soft-deleted connected accounts. Ignore dangling IDs.
      await queryInterface.sequelize.query(
        `UPDATE "PayoutMethods" pm
         SET "ConnectedAccountId" = ca.id
         FROM "ConnectedAccounts" ca
         WHERE pm.data->>'connectedAccountId' = ca.id::text`,
        { transaction },
      );
      await queryInterface.sequelize.query(
        `UPDATE "PayoutMethods" SET data = data - 'connectedAccountId'
         WHERE data ? 'connectedAccountId'`,
        { transaction },
      );
      await queryInterface.addIndex('PayoutMethods', ['ConnectedAccountId'], { transaction });
    });
  },

  async down(queryInterface: QueryInterface) {
    await queryInterface.sequelize.transaction(async transaction => {
      await queryInterface.sequelize.query(
        `UPDATE "PayoutMethods"
         SET data = data || jsonb_build_object('connectedAccountId', "ConnectedAccountId")
         WHERE "ConnectedAccountId" IS NOT NULL`,
        { transaction },
      );
      await queryInterface.removeColumn('PayoutMethods', 'ConnectedAccountId', { transaction });
    });
  },
};
