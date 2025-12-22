'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('KYCVerificationHistories', 'CreatedByUserId', {
      type: Sequelize.INTEGER,
      references: { model: 'Users', key: 'id' },
      allowNull: true,
    });

    await queryInterface.addColumn('KYCVerifications', 'CreatedByUserId', {
      type: Sequelize.INTEGER,
      references: { model: 'Users', key: 'id' },
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('KYCVerifications', 'CreatedByUserId');
    await queryInterface.removeColumn('KYCVerificationHistories', 'CreatedByUserId');
  },
};
