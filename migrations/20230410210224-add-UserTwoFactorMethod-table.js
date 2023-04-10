'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('UserTwoFactorMethods', {
      id: {
        type: Sequelize.INTEGER,
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
      },
      method: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      data: {
        type: Sequelize.JSONB,
        allowNull: true,
      },
      UserId: {
        type: Sequelize.INTEGER,
        references: { key: 'id', model: 'Users' },
        allowNull: true,
        onDelete: 'SET NULL',
        onUpdate: 'SET NULL',
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.NOW,
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.NOW,
      },
      deletedAt: {
        allowNull: true,
        type: Sequelize.DATE,
      },
    });

    await queryInterface.addIndex('UserTwoFactorMethods', ['UserId', 'method']);

    await queryInterface.sequelize.query(`
      INSERT INTO "UserTwoFactorMethods"("UserId", method, data)
      SELECT u.id, 'totp', jsonb_build_object('secret', u."twoFactorAuthToken")
      FROM "Users" u
      WHERE u."deletedAt" is NULL AND u."twoFactorAuthToken" is not null
      ON CONFLICT DO NOTHING
    `);

    await queryInterface.sequelize.query(`
      INSERT INTO "UserTwoFactorMethods"("UserId", method, data)
      SELECT u.id, 'yubikey_otp', jsonb_build_object('deviceId', u."yubikeyDeviceId")
      FROM "Users" u
      WHERE u."deletedAt" is NULL AND u."yubikeyDeviceId" is not null
      ON CONFLICT DO NOTHING
    `);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('UserTwoFactorMethods');
  },
};
