'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('PlatformSubscriptionHistories', 'featureProvisioningStatus', {
      type: Sequelize.ENUM('PENDING', 'PROVISIONED', 'DEPROVISIONED'),
      allowNull: false,
      defaultValue: 'PENDING',
    });
    await queryInterface.addColumn('PlatformSubscriptions', 'featureProvisioningStatus', {
      type: Sequelize.ENUM('PENDING', 'PROVISIONED', 'DEPROVISIONED'),
      allowNull: false,
      defaultValue: 'PENDING',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('PlatformSubscriptions', 'featureProvisioningStatus');
    await queryInterface.removeColumn('PlatformSubscriptionHistories', 'featureProvisioningStatus');
  },
};
