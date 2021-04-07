'use strict';

module.exports = {
  up: async queryInterface => {
    // Rename `UsingVirtualCardFromCollectiveId` column
    await queryInterface.renameColumn(
      'Transactions',
      'UsingVirtualCardFromCollectiveId',
      'UsingGiftCardFromCollectiveId',
    );

    // Move index on renamed column
    await queryInterface.removeIndex('Transactions', ['UsingVirtualCardFromCollectiveId']);
    await queryInterface.addIndex('Transactions', ['UsingGiftCardFromCollectiveId']);

    // Rename PaymentMethod.type
    await queryInterface.sequelize.query(`
      UPDATE  "PaymentMethods"
      SET     "type" = 'giftcard'
      WHERE   "type" = 'virtualcard'
    `);

    // Rename limitation in settings (and removes deprecated `virtualCardsMaxDailyAmount` key)
    await queryInterface.sequelize.query(`
      UPDATE  "Collectives"
      SET     settings = settings - 'virtualCardsMaxDailyCount' - 'virtualCardsMaxDailyAmount' || jsonb_build_object('giftCardsMaxDailyCount', settings->'virtualCardsMaxDailyCount')
      WHERE   settings IS NOT NULL
      AND     settings ? 'virtualCardsMaxDailyCount'
    `);
  },

  down: async queryInterface => {
    await queryInterface.sequelize.query(`
      UPDATE "PaymentMethods"
      SET "type" = 'virtualcard'
      WHERE "type" = 'giftcard'
    `);

    await queryInterface.renameColumn(
      'Transactions',
      'UsingGiftCardFromCollectiveId',
      'UsingVirtualCardFromCollectiveId',
    );

    await queryInterface.removeIndex('Transactions', ['UsingGiftCardFromCollectiveId']);
    await queryInterface.addIndex('Transactions', ['UsingVirtualCardFromCollectiveId']);
  },
};
