'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    console.log('\t - Adding lastChargedAt column to Subscriptions and SubscriptionHistories');
    await queryInterface.addColumn('Subscriptions', 'lastChargedAt', {
      type: Sequelize.DATE,
      allowNull: true,
    });

    await queryInterface.addColumn('SubscriptionHistories', 'lastChargedAt', {
      type: Sequelize.DATE,
      allowNull: true,
    });

    console.log('\t - Adding index on lastChargedAt column');
    await queryInterface.addIndex('Subscriptions', {
      name: 'Subscriptions_lastChargedAt',
      where: {
        deletedAt: { [Sequelize.Op.ne]: null },
      },
      fields: [
        {
          name: 'lastChargedAt',
          order: 'DESC',
        },
      ],
    });

    const started = Date.now();
    console.log('\t - Updating lastChargedAt for Subscriptions');
    await queryInterface.sequelize.query(`
      WITH
      updated_subcriptions AS (
        SELECT o.id AS "orderId", o."createdAt", s.id AS "subscriptionId", MAX(t."createdAt") AS "lastChargedAt"
        FROM
          "Orders" o
          INNER JOIN "Subscriptions" s ON o."SubscriptionId" = s.id AND s."deletedAt" IS NULL
          INNER JOIN "Transactions" t ON t."OrderId" = o.id AND t.kind = 'CONTRIBUTION' AND t.type = 'CREDIT' AND t."deletedAt" IS NULL
        WHERE o."deletedAt" IS NULL
          AND o."SubscriptionId" IS NOT NULL
          AND (o.status = 'ACTIVE' OR o."createdAt" > NOW() - INTERVAL '1 year')
        GROUP BY o.id, o."createdAt", s.id
        )
      UPDATE "Subscriptions" s
      SET
        "lastChargedAt" = updated_subcriptions."lastChargedAt"
      FROM updated_subcriptions
      WHERE s.id = updated_subcriptions."subscriptionId" AND updated_subcriptions."lastChargedAt" - updated_subcriptions."createdAt" > INTERVAL '10 seconds';
    `);
    console.log(`\t - Updated lastChargedAt for Subscriptions in ${Date.now() - started}ms`);
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('Subscriptions', 'Subscriptions_lastChargedAt');
    await queryInterface.removeColumn('Subscriptions', 'lastChargedAt');
    await queryInterface.removeColumn('SubscriptionHistories', 'lastChargedAt');
  },
};
