'use strict';

import { doesColumnExist } from './lib/helpers';

module.exports = {
  async up(queryInterface, Sequelize) {
    // -- Create columns --
    console.time('Creating columns');

    if (!(await doesColumnExist(queryInterface, 'Activities', 'OrderId'))) {
      await queryInterface.addColumn('Activities', 'OrderId', {
        type: Sequelize.INTEGER,
        references: { key: 'id', model: 'Orders' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        allowNull: true,
      });
    }

    if (!(await doesColumnExist(queryInterface, 'Activities', 'FromCollectiveId'))) {
      await queryInterface.addColumn('Activities', 'FromCollectiveId', {
        type: Sequelize.INTEGER,
        references: { key: 'id', model: 'Collectives' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        allowNull: true,
      });
    }

    if (!(await doesColumnExist(queryInterface, 'Activities', 'HostCollectiveId'))) {
      await queryInterface.addColumn('Activities', 'HostCollectiveId', {
        type: Sequelize.INTEGER,
        references: { key: 'id', model: 'Collectives' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        allowNull: true,
      });
    }

    console.timeEnd('Creating columns');

    // -- Create indexes --
    console.time('Creating FromCollectiveId index');
    await queryInterface.sequelize.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "activities__from_collective_id" ON "Activities" ("FromCollectiveId")`,
    );
    console.timeEnd('Creating FromCollectiveId index');

    console.time('Creating HostCollectiveId index');
    await queryInterface.sequelize.query(
      `CREATE INDEX CONCURRENTLY IF NOT EXISTS "activities__host_collective_id" ON "Activities" ("HostCollectiveId")`,
    );
    console.timeEnd('Creating HostCollectiveId index');

    // -- Fill in columns from existing data --
    console.time("Migrating User actions where FromCollectiveId/CollectiveId should be user's profile");
    await queryInterface.sequelize.query(`
      UPDATE "Activities" a
      SET
        "CollectiveId" = u."CollectiveId",
        "FromCollectiveId" = u."CollectiveId"
      FROM "Users" u
      WHERE u.id = a."UserId"
      AND a."FromCollectiveId" IS NULL
      AND a."type" IN (
        'user.created',
        'user.new.token',
        'user.changeEmail'
        )
    `);
    console.timeEnd("Migrating User actions where FromCollectiveId/CollectiveId should be user's profile");

    // Transactions
    console.time('Migrating Transaction activities');
    await queryInterface.sequelize.query(`
      UPDATE "Activities" a
      SET
        "OrderId" = t."OrderId",
        "CollectiveId" = t."CollectiveId",
        "FromCollectiveId" = t."FromCollectiveId",
        "HostCollectiveId" = t."HostCollectiveId"
      FROM "Transactions" t
      WHERE a."TransactionId" IS NOT NULL
      AND a."FromCollectiveId" IS NULL
      AND t.id = a."TransactionId"
      AND a."createdAt" >= '2022-06-01' -- This migration is too heavy, we'll run the rest separately
    `);
    console.timeEnd('Migrating Transaction activities');

    // Gift card
    console.time('Migrating gift cards');
    await queryInterface.sequelize.query(`
      UPDATE "Activities"
      SET "FromCollectiveId" = (data -> 'emitter' ->> 'id')::integer
      WHERE "type" IN ('user.card.claimed')
    `);
    console.timeEnd('Migrating gift cards');

    // Members actions
    console.time('Migrating members');
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
      AND "FromCollectiveId" IS NULL
      AND id NOT IN (136761, 154969) -- This two are broken on staging/api
    `);
    console.timeEnd('Migrating members');

    // HostCollectiveId for Virtual cards + Freeze collective
    console.time('Migrating Virtual Cards / Freeze collective activities');
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
      AND "HostCollectiveId" IS NULL
    `);
    console.timeEnd('Migrating Virtual Cards / Freeze collective activities');

    // Subscriptions and CONTRIBUTION_REJECTED
    console.time('Migrating subscriptions & rejected contributions');
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
      AND "FromCollectiveId" IS NULL
      AND id != 170601 -- This one is corrupted in prod
    `);
    console.timeEnd('Migrating subscriptions & rejected contributions');

    // Expense actions
    console.time('Migrating expense activities');
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
      AND "FromCollectiveId" IS NULL
      AND "HostCollectiveId" IS NULL
    `);
    console.timeEnd('Migrating expense activities');

    // Expense moved root action
    console.time('Migrating expense moved root activities');
    await queryInterface.sequelize.query(`
      UPDATE "Activities"
      SET "FromCollectiveId" = ("data" -> 'movedFromCollective' ->> 'id')::integer,
          "HostCollectiveId" = ("data" -> 'movedFromCollective' ->> 'HostCollectiveId')::integer
      WHERE "type" IN ('collective.expense.moved')
      AND "FromCollectiveId" IS NULL
      AND "HostCollectiveId" IS NULL
    `);
    console.timeEnd('Migrating expense moved root activities');

    // Order actions: from data
    console.time('Migrating Orders activities from data');
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
      AND "FromCollectiveId" IS NULL
      AND "OrderId" IS NULL
    `);
    console.timeEnd('Migrating Orders activities from data');

    // Order actions: complete data from join
    console.time('Migrating Orders activities from joins');
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
    console.timeEnd('Migrating Orders activities from joins');

    // Contact
    console.time('Migrating contact activities');
    await queryInterface.sequelize.query(`
      UPDATE "Activities"
      SET "FromCollectiveId" = ("data" -> 'fromCollective' ->> 'id')::integer
      WHERE "type" IN ('collective.contact')
      AND "FromCollectiveId" IS NULL
    `);
    console.timeEnd('Migrating contact activities');

    // Comments / conversations
    console.time('Migrating comment/conversation activities');
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
      AND "FromCollectiveId" IS NULL
    `);
    console.timeEnd('Migrating comment/conversation activities');

    // Updates
    console.time('Migrating updates activities');
    await queryInterface.sequelize.query(`
      UPDATE "Activities"
      SET "FromCollectiveId" = ("data" -> 'update' ->> 'FromCollectiveId')::integer
      WHERE "type" IN (
        'collective.update.created',
        'collective.update.published'
      )
      AND "FromCollectiveId" IS NULL
    `);
    console.timeEnd('Migrating updates activities');

    // Host actions
    console.time('Migrating host actions activities');
    await queryInterface.sequelize.query(`
      UPDATE "Activities"
      SET "HostCollectiveId" = (data -> 'host' ->> 'id')::integer
      WHERE "type" IN (
        'collective.apply',
        'collective.created'
      )
      AND "HostCollectiveId" IS NULL
    `);
    console.timeEnd('Migrating host actions activities');

    // Host status
    console.time('Migrating host status activities');
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
      AND "HostCollectiveId" IS NULL
      AND "FromCollectiveId" IS NULL
    `);
    console.timeEnd('Migrating host status activities');

    // Generic linker for HostCollectiveId
    // 'virtualcard.charge.declined' will get its HostCollectiveId set in the generic HostCollectiveId linker below (the data payload doesn't have the host id)
    console.time('Populating HostCollectiveId for activities using JOIN');
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
    console.timeEnd('Populating HostCollectiveId for activities using JOIN');
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('Activities', 'FromCollectiveId');
    await queryInterface.removeColumn('Activities', 'HostCollectiveId');
    await queryInterface.removeColumn('Activities', 'OrderId');
  },
};
