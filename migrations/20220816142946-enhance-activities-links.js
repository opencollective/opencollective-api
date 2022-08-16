'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // -- Create columns --
    await queryInterface.addColumn('Activities', 'OrderId', {
      type: Sequelize.INTEGER,
      references: { key: 'id', model: 'Orders' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    });

    await queryInterface.addColumn('Activities', 'FromCollectiveId', {
      type: Sequelize.INTEGER,
      references: { key: 'id', model: 'Collectives' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    });

    await queryInterface.addColumn('Activities', 'HostCollectiveId', {
      type: Sequelize.INTEGER,
      references: { key: 'id', model: 'Collectives' },
      onDelete: 'SET NULL',
      onUpdate: 'CASCADE',
      allowNull: true,
    });

    // -- Create indexes --
    await queryInterface.addIndex('Activities', ['FromCollectiveId'], {
      concurrently: true,
      where: { FromCollectiveId: { [Sequelize.Op.ne]: null } },
    });

    await queryInterface.addIndex('Activities', ['HostCollectiveId'], {
      concurrently: true,
      where: { HostCollectiveId: { [Sequelize.Op.ne]: null } },
    });

    // -- Fill in columns from existing data --
    console.log("Migrating User actions where FromCollectiveId/CollectiveId should be user's profile");
    await queryInterface.sequelize.query(`
      UPDATE "Activities" a
      SET
        "CollectiveId" = u."CollectiveId",
        "FromCollectiveId" = u."CollectiveId"
      FROM "Users" u
      WHERE u.id = a."UserId"
      AND a."type" IN (
        'user.created',
        'user.new.token',
        'user.changeEmail'
      )
    `);

    // Transactions
    console.log('Migrating Transaction activities');
    await queryInterface.sequelize.query(`
      UPDATE "Activities" a
      SET
        "OrderId" = t."OrderId",
        "CollectiveId" = t."CollectiveId",
        "FromCollectiveId" = t."FromCollectiveId",
        "HostCollectiveId" = t."HostCollectiveId"
      FROM "Transactions" t
      WHERE a."TransactionId" IS NOT NULL
      AND t.id = a."TransactionId"
    `);

    // Gift card
    console.log('Migrating gift cards');
    await queryInterface.sequelize.query(`
      UPDATE "Activities"
      SET "FromCollectiveId" = (data -> 'emitter' ->> 'id')::integer
      WHERE "type" IN ('user.card.claimed')
    `);

    // Members actions
    console.log('Migrating members');
    await queryInterface.sequelize.query(`
      UPDATE "Activities"
      SET "FromCollectiveId" = COALESCE(
        (data -> 'memberCollective' ->> 'id')::integer,
        (data -> 'member' -> 'memberCollective' ->> 'id')::integer,
        NULL
      )
      WHERE "type" IN (
        'collective.member.invited',
        'collective.member.created',
        'collective.core.member.added',
        'collective.core.member.invited',
        'collective.core.member.invitation.declined',
        'collective.core.member.removed',
        'collective.core.member.edited'
      )
    `);

    // HostCollectiveId for Virtual cards + Freeze collective
    console.log('Migrating Virtual Cards / Freeze collective activities');
    await queryInterface.sequelize.query(`
      UPDATE "Activities"
      SET "HostCollectiveId" = (data -> 'host' ->> 'id')::integer
      WHERE "type" IN (
        'collective.virtualcard.missing.receipts',
        'collective.virtualcard.suspended',
        'collective.virtualcard.added',
        'virtual_card.requested',
        'collective.frozen',
        'collective.unfrozen'
      )
    `);

    // Subscriptions and CONTRIBUTION_REJECTED
    console.log('Migrating subscriptions & rejected contributions');
    await queryInterface.sequelize.query(`
      UPDATE "Activities"
      SET
        "CollectiveId" = COALESCE("CollectiveId", (data -> 'collective' ->> 'id')::integer, (data -> 'group' ->> 'id')::integer), -- Some old activities from < 2018 are missing this field
        "FromCollectiveId" = (data -> 'fromCollective' ->> 'id')::integer -- Can be null for subscription.confirmed < 2018
      WHERE "type" IN (
        'subscription.activated',
        'subscription.confirmed',
        'subscription.canceled',
        'contribution.rejected'
      )
    `);

    // Expense actions
    console.log('Migrating expense activities');
    await queryInterface.sequelize.query(`
      UPDATE "Activities"
      SET
        "FromCollectiveId" = ("data" -> 'fromCollective' ->> 'id')::integer,
        "HostCollectiveId" = ("data" -> 'host' ->> 'id')::integer
      WHERE "type" IN (
        'collective.expense.created',
        'collective.expense.deleted',
        'collective.expense.updated',
        'collective.expense.rejected',
        'collective.expense.approved',
        'collective.expense.unapproved',
        'collective.expense.moved',
        'collective.expense.paid',
        'collective.expense.unpaid',
        'collective.expense.spam',
        'collective.expense.incomplete',
        'collective.expense.processing',
        'collective.expense.scheduledForPayment',
        'collective.expense.error',
        'collective.expense.invite.drafted',
        'collective.expense.recurring.drafted',
        'collective.expense.missing.receipt'
      )
    `);

    // Order actions: from data
    console.log('Migrating Orders activities from data');
    await queryInterface.sequelize.query(`
      UPDATE "Activities"
      SET
        "OrderId" = ("data" -> 'order' ->> 'id')::integer,
        "FromCollectiveId" = COALESCE("data" -> 'fromCollective' ->> 'id', data -> 'order' ->> 'FromCollectiveId')::integer,
        "CollectiveId" = COALESCE("CollectiveId", ("data" -> 'collective' ->> 'id')::integer),
        "HostCollectiveId" = COALESCE("data" -> 'host' ->> 'id', "data" -> 'collective' ->> 'HostCollectiveId')::integer -- Can be null
      WHERE "type" IN (
        'order.canceled.archived.collective',
        'order.processing',
        'order.processing.crypto',
        'order.new.pendingFinancialContribution',
        'order.reminder.pendingFinancialContribution',
        'order.thankyou',
        'orders.suspicious',
        'payment.failed',
        'payment.creditcard.confirmation'
      )
    `);

    // Order actions: complete data from join
    console.log('Migrating Orders activities from joins');
    await queryInterface.sequelize.query(`
      UPDATE "Activities" a
      SET
        "FromCollectiveId" = COALESCE(a."FromCollectiveId", o."FromCollectiveId"),
        "CollectiveId" = COALESCE(a."CollectiveId", o."CollectiveId")
      FROM "Orders" o
      WHERE a."OrderId" IS NOT NULL
      AND o.id = a."OrderId"
      AND (a."FromCollectiveId" IS NULL OR a."CollectiveId" IS NULL)
    `);

    // Contact
    console.log('Migrating contact activities');
    await queryInterface.sequelize.query(`
      UPDATE "Activities"
      SET "FromCollectiveId" = ("data" -> 'fromCollective' ->> 'id')::integer
      WHERE "type" IN (
        'collective.contact'
      )
    `);

    // Comments / conversations
    console.log('Migrating comment/conversation activities');
    await queryInterface.sequelize.query(`
      UPDATE "Activities"
      SET "FromCollectiveId" = ("data" ->> 'FromCollectiveId')::integer
      WHERE "type" IN (
        'collective.comment.created',
        'collective.conversation.created'
        'conversation.comment.created',
        'update.comment.created',
        'expense.comment.created'
      )
    `);

    // Updates
    console.log('Migrating updates activities');
    await queryInterface.sequelize.query(`
      UPDATE "Activities"
      SET "FromCollectiveId" = ("data" -> 'update' ->> 'FromCollectiveId')::integer
      WHERE "type" IN (
        'collective.update.created',
        'collective.update.published'
      )
    `);

    // Host actions
    console.log('Migrating host actions activities');
    await queryInterface.sequelize.query(`
      UPDATE "Activities"
      SET "HostCollectiveId" = (data -> 'host' ->> 'id')::integer
      WHERE "type" IN (
        'collective.apply',
        'collective.created'
      )
    `);

    // Host status
    console.log('Migrating host status activities');
    await queryInterface.sequelize.query(`
      UPDATE "Activities"
      SET
        "HostCollectiveId" = (data -> 'collective' ->> 'id')::integer,
        "FromCollectiveId" = (data -> 'collective' ->> 'id')::integer
      WHERE "type" IN (
        'activated.collective.as.host',
        'activated.collective.as.independent',
        'deactivated.collective.as.host'
      )
    `);

    // Generic linker for HostCollectiveId
    // 'virtualcard.charge.declined' will get its HostCollectiveId set in the generic HostCollectiveId linker below (the data payload doesn't have the host id)
    console.log('Populating HostCollectiveId for activities using JOIN');
    await queryInterface.sequelize.query(`
      UPDATE "Activities" a
      SET "HostCollectiveId" = c."HostCollectiveId"
      FROM "Collectives" c
      WHERE c.id = a."CollectiveId"
      AND a."HostCollectiveId" IS NULL
      -- Only set HostCollectiveId for collectives approved after the activity. We'll miss some past activities if the collective changed its host
      AND c."HostCollectiveId" IS NOT NULL
      AND c."approvedAt" IS NOT NULL
      AND a."createdAt" >= c."approvedAt"
    `);
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Activities', 'FromCollectiveId');
    await queryInterface.removeColumn('Activities', 'HostCollectiveId');
    await queryInterface.removeColumn('Activities', 'OrderId');
  },
};
