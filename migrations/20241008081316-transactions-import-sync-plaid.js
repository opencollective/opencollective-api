'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    // Add columns
    await queryInterface.addColumn('TransactionsImports', 'data', {
      type: Sequelize.JSONB,
      allowNull: true,
    });

    await queryInterface.addColumn('TransactionsImports', 'settings', {
      type: Sequelize.JSONB,
      allowNull: true,
    });

    await queryInterface.addColumn('TransactionsImports', 'lastSyncAt', {
      type: Sequelize.DATE,
      allowNull: true,
    });

    await queryInterface.addColumn('TransactionsImports', 'ConnectedAccountId', {
      type: Sequelize.INTEGER,
      references: { model: 'ConnectedAccounts', key: 'id' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    });

    await queryInterface.addColumn('TransactionsImportsRows', 'isUnique', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });

    // Set lastSyncAt to createdAt for all existing imports
    await queryInterface.sequelize.query(`
      UPDATE "TransactionsImports" SET "lastSyncAt" = "createdAt"
    `);

    // Move `csvConfig` to `settings`
    await queryInterface.sequelize.query(`
      UPDATE "TransactionsImports"
      SET "settings" = jsonb_build_object('csvConfig', "csvConfig")
      WHERE "csvConfig" IS NOT NULL
    `);

    // Add a unique index on `ConnectedAccountId` > `sourceId` for plaid imports. We can't yet enforce this for
    // CSV because they're no interface for users to define unique. See https://github.com/opencollective/opencollective/issues/7608.
    await queryInterface.addIndex('TransactionsImportsRows', ['TransactionsImportId', 'sourceId'], {
      unique: true,
      where: { isUnique: true },
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('TransactionsImports', 'data');
    await queryInterface.removeColumn('TransactionsImports', 'settings');
    await queryInterface.removeColumn('TransactionsImports', 'lastSyncAt');
    await queryInterface.removeColumn('TransactionsImports', 'ConnectedAccountId');
    await queryInterface.removeColumn('TransactionsImportsRows', 'isUnique');
    await queryInterface.removeIndex('TransactionsImportsRows', ['TransactionsImportId', 'sourceId']);
  },
};
