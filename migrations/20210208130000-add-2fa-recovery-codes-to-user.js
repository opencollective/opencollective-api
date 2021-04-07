'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('Users', 'twoFactorAuthRecoveryCodes', {
      type: Sequelize.ARRAY(Sequelize.STRING),
      allowNull: true,
      defaultValue: null,
    });
    await queryInterface.addColumn('UserHistories', 'twoFactorAuthRecoveryCodes', {
      type: Sequelize.ARRAY(Sequelize.STRING),
      allowNull: true,
      defaultValue: null,
    });
  },

  down: async queryInterface => {
    await queryInterface.removeColumn('Users', 'twoFactorAuthRecoveryCodes');
    await queryInterface.removeColumn('UserHistories', 'twoFactorAuthRecoveryCodes');
  },
};
