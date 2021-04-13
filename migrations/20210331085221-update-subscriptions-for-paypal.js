'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    // Add isManagedExternally
    let colParams = { type: Sequelize.BOOLEAN, defaultValue: false };
    await queryInterface.addColumn('Subscriptions', 'isManagedExternally', colParams);
    await queryInterface.addColumn('SubscriptionHistories', 'isManagedExternally', colParams);
    await queryInterface.sequelize.query('UPDATE "Subscriptions" SET "isManagedExternally" = false;');

    // Add paypalSubscriptionId
    colParams = { type: Sequelize.STRING, allowNull: true };
    await queryInterface.addColumn('Subscriptions', 'paypalSubscriptionId', colParams);
    await queryInterface.addColumn('SubscriptionHistories', 'paypalSubscriptionId', colParams);
    await queryInterface.addIndex('Subscriptions', ['paypalSubscriptionId'], { unique: true });
  },

  down: async queryInterface => {
    await queryInterface.removeColumn('Subscriptions', 'isManagedExternally');
    await queryInterface.removeColumn('SubscriptionHistories', 'isManagedExternally');
    await queryInterface.removeColumn('Subscriptions', 'paypalSubscriptionId');
    await queryInterface.removeColumn('SubscriptionHistories', 'paypalSubscriptionId');
  },
};
