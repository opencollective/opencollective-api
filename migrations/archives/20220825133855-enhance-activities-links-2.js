'use strict';

module.exports = {
  async up(queryInterface) {
    console.time('Linking order on contribution/subscription activities');
    await queryInterface.sequelize.query(`
      UPDATE "Activities" a
      SET "OrderId" = o.id
      FROM "Orders" o
      WHERE a.type IN (
        'subscription.activated',
        'subscription.confirmed',
        'subscription.canceled',
        'contribution.rejected'
      )
      AND a."OrderId" IS NULL
      AND a.data -> 'subscription' ->> 'id' IS NOT NULL
      AND o."SubscriptionId" = (a.data -> 'subscription' ->> 'id')::int
    `);
    console.timeEnd('Linking order on contribution/subscription activities');

    console.time('Linking User on update created activities');
    await queryInterface.sequelize.query(`
      UPDATE "Activities" a
      SET "UserId" = u."CreatedByUserId"
      FROM "Updates" u
      WHERE a.type IN ('collective.update.created')
      AND a."UserId" IS NULL
      AND data -> 'update' ->> 'id' IS NOT NULL -- We have no cases, but just to be safe...
      AND u.id = (data -> 'update' ->> 'id')::int
    `);
    console.timeEnd('Linking User on update created activities');
  },

  async down() {
    // No rollback needed
  },
};
