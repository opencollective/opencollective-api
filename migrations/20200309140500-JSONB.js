'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    /** Activity */
    await queryInterface.changeColumn('Activities', 'data', {
      type: Sequelize.JSONB,
    });

    /** Collective */
    await queryInterface.changeColumn('Collectives', 'data', {
      type: Sequelize.JSONB,
    });
    await queryInterface.changeColumn('CollectiveHistories', 'data', {
      type: Sequelize.JSONB,
    });
    await queryInterface.changeColumn('Collectives', 'settings', {
      type: Sequelize.JSONB,
    });
    await queryInterface.changeColumn('CollectiveHistories', 'settings', {
      type: Sequelize.JSONB,
    });

    /** ConnectedAccount */
    await queryInterface.changeColumn('ConnectedAccounts', 'data', {
      type: Sequelize.JSONB,
    });
    await queryInterface.changeColumn('ConnectedAccounts', 'settings', {
      type: Sequelize.JSONB,
    });

    /** Order */
    await queryInterface.changeColumn('Orders', 'data', {
      type: Sequelize.JSONB,
    });
    await queryInterface.changeColumn('OrderHistories', 'data', {
      type: Sequelize.JSONB,
    });

    /** Payment Method */
    await queryInterface.changeColumn('PaymentMethods', 'data', {
      type: Sequelize.JSONB,
    });

    /** Payout Method */
    await queryInterface.changeColumn('PayoutMethods', 'data', {
      type: Sequelize.JSONB,
    });

    /** Subscription */
    await queryInterface.changeColumn('Subscriptions', 'data', {
      type: Sequelize.JSONB,
    });
    await queryInterface.changeColumn('SubscriptionHistories', 'data', {
      type: Sequelize.JSONB,
    });

    /** Tier */
    await queryInterface.changeColumn('Tiers', 'data', {
      type: Sequelize.JSONB,
    });
    await queryInterface.changeColumn('TierHistories', 'data', {
      type: Sequelize.JSONB,
    });
    await queryInterface.changeColumn('Tiers', 'customFields', {
      type: Sequelize.JSONB,
    });
    await queryInterface.changeColumn('TierHistories', 'customFields', {
      type: Sequelize.JSONB,
    });

    /** Transaction */
    await queryInterface.changeColumn('Transactions', 'data', {
      type: Sequelize.JSONB,
    });

    /** User */
    await queryInterface.changeColumn('Users', 'data', {
      type: Sequelize.JSONB,
    });
  },

  down: async (queryInterface, Sequelize) => {
    /** Activity */
    await queryInterface.changeColumn('Activities', 'data', {
      type: Sequelize.JSON,
    });

    /** Collective */
    await queryInterface.changeColumn('Collectives', 'data', {
      type: Sequelize.JSON,
    });
    await queryInterface.changeColumn('CollectiveHistories', 'data', {
      type: Sequelize.JSON,
    });
    await queryInterface.changeColumn('Collectives', 'settings', {
      type: Sequelize.JSON,
    });
    await queryInterface.changeColumn('CollectiveHistories', 'settings', {
      type: Sequelize.JSON,
    });

    /** ConnectedAccount */
    await queryInterface.changeColumn('ConnectedAccounts', 'data', {
      type: Sequelize.JSON,
    });
    await queryInterface.changeColumn('ConnectedAccounts', 'settings', {
      type: Sequelize.JSON,
    });

    /** Order */
    await queryInterface.changeColumn('Orders', 'data', {
      type: Sequelize.JSON,
    });
    await queryInterface.changeColumn('OrderHistories', 'data', {
      type: Sequelize.JSON,
    });

    /** Payment Method */
    await queryInterface.changeColumn('PaymentMethods', 'data', {
      type: Sequelize.JSON,
    });

    /** Payout Method */
    await queryInterface.changeColumn('PayoutMethods', 'data', {
      type: Sequelize.JSON,
    });

    /** Subscription */
    await queryInterface.changeColumn('Subscriptions', 'data', {
      type: Sequelize.JSON,
    });
    await queryInterface.changeColumn('SubscriptionHistories', 'data', {
      type: Sequelize.JSON,
    });

    /** Tier */
    await queryInterface.changeColumn('Tiers', 'data', {
      type: Sequelize.JSON,
    });
    await queryInterface.changeColumn('TierHistories', 'data', {
      type: Sequelize.JSON,
    });
    await queryInterface.changeColumn('Tiers', 'customFields', {
      type: Sequelize.JSON,
    });
    await queryInterface.changeColumn('TierHistories', 'customFields', {
      type: Sequelize.JSON,
    });

    /** Transaction */
    await queryInterface.changeColumn('Transactions', 'data', {
      type: Sequelize.JSON,
    });

    /** User */
    await queryInterface.changeColumn('Users', 'data', {
      type: Sequelize.JSON,
    });
  },
};
