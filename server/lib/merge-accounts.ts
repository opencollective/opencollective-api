import { flatten, isEmpty, keyBy, mapValues, some } from 'lodash';
import { DestroyOptions, Model, ModelStatic, Transaction as SQLTransaction } from 'sequelize';

import { CollectiveType } from '../constants/collectives';
import models, { Collective, Op, sequelize } from '../models';
import { MigrationLogType } from '../models/MigrationLog';
import User from '../models/User';

import { DEFAULT_GUEST_NAME } from './guest-accounts';
import { safeJsonStringify } from './safe-json-stringify';

const countEntities = async (fieldsConfig, entityId) => {
  const resultsList = await Promise.all(
    Object.keys(fieldsConfig).map(async entity => {
      const entityConfig = fieldsConfig[entity];
      return { entity, count: await entityConfig.model.count({ where: { [entityConfig.field]: entityId } }) };
    }),
  );

  // Transform the results from `[{entity: 'updates', count: 42}]` to `{updates: 42}`
  return mapValues(keyBy(resultsList, 'entity'), 'count');
};

/**
 * Get a summary of all items handled by the `mergeAccounts` function
 */
export const getMovableItemsCounts = async (
  fromCollective: Collective,
): Promise<{
  account: Record<keyof CollectiveFieldsConfig, number>;
  user: Record<keyof UserFieldsConfig, number>;
}> => {
  if (fromCollective.type === CollectiveType.USER && !fromCollective.isIncognito) {
    const user = await fromCollective.getUser({ paranoid: false });
    if (!user) {
      throw new Error('Cannot find user for this account');
    }

    return {
      account: await countEntities(collectiveFieldsConfig, fromCollective.id),
      user: await countEntities(userFieldsConfig, user.id),
    };
  } else {
    return {
      account: await countEntities(collectiveFieldsConfig, fromCollective.id),
      user: null,
    };
  }
};

/**
 * Moving transactions between accounts makes the balance/checkpoint materialized views stale for both accounts
 * until they are refreshed (they are only refreshed by the daily cron). Rather than blocking the merge, we warn
 * about it and point to the refresh command.
 */
const getStaleBalancesWarning = (from: Collective, into: Collective): string =>
  `Merging ${from.slug} into ${into.slug} moves transactions: balances will be stale until the materialized views are refreshed. Run \`npm run script cron/daily/92-refresh-daily-materialized-views.ts\` to refresh them now, or wait for the next daily refresh.`;

const checkMergeCollective = (from: Collective, into: Collective): void => {
  const isProjectIntoCollective = from?.type === CollectiveType.PROJECT && into?.type === CollectiveType.COLLECTIVE;
  if (!from || !into) {
    throw new Error('Cannot merge profiles, one of them does not exist');
  } else if (from.type !== into.type && !isProjectIntoCollective) {
    throw new Error('Cannot merge accounts with different types');
  } else if (from.id === into.id) {
    throw new Error('Cannot merge an account into itself');
  } else if (from.id === into.ParentCollectiveId) {
    throw new Error('You can not merge an account with its parent');
  } else if (from.id === into.HostCollectiveId) {
    throw new Error('You can not merge an account with its host');
  } else if (isProjectIntoCollective) {
    // Cross-type merges are only allowed for PROJECT -> COLLECTIVE, and only when both accounts
    // share the same (non-null) host. The target must not be a fiscal host (money management account).
    if (into.hasMoneyManagement) {
      throw new Error('Cannot merge an account into a fiscal host');
    } else if (!from.HostCollectiveId || from.HostCollectiveId !== into.HostCollectiveId) {
      throw new Error('A project can only be merged into a collective hosted by the same host');
    }
  }
};

/**
 * Simulate the `mergeAccounts` function. Returns a summary of the changes as a string
 */
export const simulateMergeAccounts = async (from: Collective, into: Collective): Promise<string> => {
  // Detect errors that would completely block the process (throws)
  checkMergeCollective(from, into);

  // Generate a summary of the changes
  const movedItemsCounts = await getMovableItemsCounts(from);
  let summary = 'The profiles information will be merged.\n\n';

  const addLineToSummary = str => {
    summary += `${str}\n`;
  };

  const addCountsToSummary = (counts: Record<string, number>) => {
    Object.entries(counts).forEach(([key, count]) => {
      if (count > 0) {
        addLineToSummary(`  - ${key}: ${count}`);
      }
    });
  };

  if (some(movedItemsCounts.account, count => count > 0)) {
    addLineToSummary(`The following items will be moved to @${into.slug}:`);
    addCountsToSummary(movedItemsCounts.account);
    addLineToSummary('');
  }

  // Generate the list of warnings
  const warnings = [];
  if (from.type === CollectiveType.PROJECT && into.type === CollectiveType.COLLECTIVE) {
    warnings.push(
      `Virtual cards will be moved to @${into.slug} and can draw on its total balance (the Stripe per-charge check uses the account balance)`,
      `Administrators of the parent of ${from.slug} will lose access to the moved data (administrators and host of @${into.slug} gain it)`,
      `Recurring contributions will continue against @${into.slug} (subscriptions hang off orders, the host does not change)`,
      `Old URLs for ${from.slug} will return 404 after the merge`,
    );
  }

  const movedTransactionsCount = ['creditTransactions', 'debitTransactions', 'giftCardTransactions'].reduce(
    (count, entity) => count + (movedItemsCounts.account[entity] || 0),
    0,
  );
  if (movedTransactionsCount > 0) {
    warnings.push(getStaleBalancesWarning(from, into));
  }

  const [targetTiers, sourceTiers] = await Promise.all([
    models.Tier.findAll({ where: { CollectiveId: into.id }, attributes: ['id', 'slug'], raw: true }),
    models.Tier.findAll({ where: { CollectiveId: from.id }, attributes: ['id', 'slug'], raw: true }),
  ]);
  getTierReslugPlan(sourceTiers, targetTiers).forEach(({ oldSlug, newSlug }) => {
    warnings.push(
      `The tier "${oldSlug}" of ${from.slug} will be re-sluged to "${newSlug}" to avoid a slug collision on @${into.slug}`,
    );
  });

  if (warnings.length) {
    addLineToSummary('Warnings:');
    warnings.forEach(warning => addLineToSummary(`  - ${warning}`));
    addLineToSummary('');
  }

  return summary;
};

/** Legal documents have a unique key on CollectiveId/type/year. We need to ignore the ones that already exist */
const getLegalDocumentsToIgnore = async (from, into, transaction): Promise<number[]> => {
  const results = (await models.LegalDocument.findAll({
    attributes: [[sequelize.fn('ARRAY_AGG', sequelize.fn('DISTINCT', sequelize.col('id'))), 'ids']],
    where: { CollectiveId: [from.id, into.id] },
    group: ['documentType', 'year'],
    transaction,
    raw: true,
    having: sequelize.where(sequelize.fn('COUNT', sequelize.fn('DISTINCT', sequelize.col('id'))), { [Op.gt]: 1 }),
  })) as unknown as Array<{ ids: number[] }>;

  return results.flatMap(({ ids }) => ids);
};

/** Accounting categories have a unique key on CollectiveId/code. We need to ignore the ones that already exist */
const getAccountingCategoriesToIgnore = async (from: Collective, into: Collective, transaction): Promise<number[]> => {
  const targetCategories = await models.AccountingCategory.findAll({
    attributes: ['code'],
    where: { CollectiveId: into.id },
    raw: true,
    transaction,
  });

  // Categories with a null code can never conflict (the unique index ignores nulls)
  const targetCodes = targetCategories.map(({ code }) => code).filter(code => code !== null);
  if (!targetCodes.length) {
    return [];
  }

  const duplicates = await models.AccountingCategory.findAll({
    attributes: ['id'],
    where: { CollectiveId: from.id, code: targetCodes },
    raw: true,
    transaction,
  });

  return duplicates.map(({ id }) => id);
};

/**
 * Before deleting duplicate accounting categories, re-point everything that references them to the surviving
 * category. Without this, the FK constraints (`ON DELETE SET NULL` / `ON DELETE CASCADE`) would silently clear
 * or destroy the references.
 */
const rePointAccountingCategoryReferences = async (
  from: Collective,
  into: Collective,
  idsToIgnore: number[],
  transaction,
): Promise<void> => {
  const duplicates = await models.AccountingCategory.findAll({
    attributes: ['id', 'code'],
    where: { id: idsToIgnore },
    raw: true,
    transaction,
  });

  for (const duplicate of duplicates) {
    const survivingCategory = await models.AccountingCategory.findOne({
      attributes: ['id'],
      where: { CollectiveId: into.id, code: duplicate.code },
      raw: true,
      transaction,
    });

    if (survivingCategory) {
      await models.Expense.update(
        { AccountingCategoryId: survivingCategory.id },
        {
          where: { AccountingCategoryId: duplicate.id },
          fields: ['AccountingCategoryId'],
          paranoid: false, // Also update soft-deleted entries
          hooks: false,
          sideEffects: false,
          validate: false,
          transaction,
        },
      );

      await models.Order.update(
        { AccountingCategoryId: survivingCategory.id },
        {
          where: { AccountingCategoryId: duplicate.id },
          fields: ['AccountingCategoryId'],
          paranoid: false, // Also update soft-deleted entries
          hooks: false,
          sideEffects: false,
          validate: false,
          transaction,
        },
      );

      await models.Expense.update(
        { BalanceAccountingCategoryId: survivingCategory.id },
        {
          where: { BalanceAccountingCategoryId: duplicate.id },
          fields: ['BalanceAccountingCategoryId'],
          paranoid: false, // Also update soft-deleted entries
          hooks: false,
          sideEffects: false,
          validate: false,
          transaction,
        },
      );

      await models.Order.update(
        { BalanceAccountingCategoryId: survivingCategory.id },
        {
          where: { BalanceAccountingCategoryId: duplicate.id },
          fields: ['BalanceAccountingCategoryId'],
          paranoid: false, // Also update soft-deleted entries
          hooks: false,
          sideEffects: false,
          validate: false,
          transaction,
        },
      );

      await models.AccountingCategoryRule.update(
        { AccountingCategoryId: survivingCategory.id },
        {
          where: { AccountingCategoryId: duplicate.id },
          fields: ['AccountingCategoryId'],
          paranoid: false, // Also update soft-deleted entries
          hooks: false,
          sideEffects: false,
          validate: false,
          transaction,
        },
      );
    }
  }
};

/**
 * Notifications have a unique key on (type, CollectiveId, UserId) and are logically duplicated by
 * (channel, type, webhookUrl) for webhook-style rows. When moving `CollectiveId` (from -> into), drop the
 * source's rows that already exist on the target so we neither break the unique key nor register the same
 * webhook twice.
 */
const getNotificationsToIgnore = async (from: Collective, into: Collective, transaction): Promise<number[]> => {
  const [targetRows, sourceRows] = await Promise.all([
    models.Notification.findAll({
      attributes: ['id', 'channel', 'type', 'webhookUrl', 'UserId'],
      where: { CollectiveId: into.id },
      raw: true,
      transaction,
    }),
    models.Notification.findAll({
      attributes: ['id', 'channel', 'type', 'webhookUrl', 'UserId'],
      where: { CollectiveId: from.id },
      raw: true,
      transaction,
    }),
  ]);

  return sourceRows
    .filter(source =>
      targetRows.some(
        target =>
          // Same user already has this notification type on the target (unique (type, CollectiveId, UserId))
          (source.UserId && source.UserId === target.UserId && source.type === target.type) ||
          // Same webhook/slack destination (channel/type/webhook URL) already registered on the target, even
          // when added by a different user: such duplicates would deliver the same event twice
          (source.webhookUrl &&
            source.channel === target.channel &&
            source.type === target.type &&
            source.webhookUrl === target.webhookUrl),
      ),
    )
    .map(({ id }) => id);
};

/**
 * Emoji reactions have partial unique keys on (CommentId|UpdateId, FromCollectiveId, emoji). When moving
 * `FromCollectiveId` (from -> into), drop the source's reactions that already exist on the target.
 */
const getEmojiReactionsToIgnore = async (from: Collective, into: Collective, transaction): Promise<number[]> => {
  const [targetRows, sourceRows] = await Promise.all([
    models.EmojiReaction.findAll({
      attributes: ['id', 'CommentId', 'UpdateId', 'emoji'],
      where: { FromCollectiveId: into.id },
      raw: true,
      transaction,
    }),
    models.EmojiReaction.findAll({
      attributes: ['id', 'CommentId', 'UpdateId', 'emoji'],
      where: { FromCollectiveId: from.id },
      raw: true,
      transaction,
    }),
  ]);

  return sourceRows
    .filter(source =>
      targetRows.some(
        target =>
          source.emoji === target.emoji && source.CommentId === target.CommentId && source.UpdateId === target.UpdateId,
      ),
    )
    .map(({ id }) => id);
};

const getAccountingCategoriesDuplicatesWarning = async (
  from: Collective,
  into: Collective,
  idsToIgnore: number[],
  transaction,
): Promise<string> => {
  const duplicates = await models.AccountingCategory.findAll({
    attributes: ['code'],
    where: { id: idsToIgnore },
    raw: true,
    transaction,
  });

  const codes = duplicates
    .map(({ code }) => code)
    .filter(Boolean)
    .map(code => `"${code}"`)
    .join(', ');

  return `Duplicate accounting categories for ${from.slug} were deleted as ${into.slug} already has them (codes: ${codes}) - expenses and orders using these codes were re-pointed to ${into.slug}'s categories`;
};

const getNotificationsDuplicatesWarning = async (from: Collective, into: Collective): Promise<string> =>
  `Duplicate notifications for ${from.slug} were deleted as ${into.slug} already has them (same channel/type/webhook URL or same user/type)`;

const getEmojiReactionsDuplicatesWarning = async (from: Collective, into: Collective): Promise<string> =>
  `Duplicate emoji reactions for ${from.slug} were deleted as ${into.slug} already reacted with the same emoji on the same comments/updates`;

/**
 * Tier slugs must be unique within a collective (they're used as filters in queries), but there is no DB
 * constraint for it. Compute which moved tiers must be re-sluged with a numeric suffix on collision with a
 * tier of the target (or another moved tier).
 */
const getTierReslugPlan = (
  sourceTiers: Array<{ id: number; slug: string }>,
  targetTiers: Array<{ id: number; slug: string }>,
): Array<{ tierId: number; oldSlug: string; newSlug: string }> => {
  const reslugs = [];
  const takenSlugs = new Set(targetTiers.map(({ slug }) => slug));
  for (const tier of sourceTiers) {
    if (!takenSlugs.has(tier.slug)) {
      takenSlugs.add(tier.slug);
      continue;
    }

    let newSlug;
    for (let i = 2; !newSlug || takenSlugs.has(newSlug); i++) {
      newSlug = `${tier.slug}-${i}`;
    }

    takenSlugs.add(newSlug);
    reslugs.push({ tierId: tier.id, oldSlug: tier.slug, newSlug });
  }

  return reslugs;
};

/**
 * When moving tiers to the target, keep the target's tier on slug collisions and re-slug the moved one with a
 * numeric suffix. Returns notes for the merge summary.
 */
const reslugTiersOnCollision = async (from: Collective, into: Collective, transaction): Promise<string[]> => {
  const [targetTiers, sourceTiers] = await Promise.all([
    models.Tier.findAll({ where: { CollectiveId: into.id }, attributes: ['id', 'slug'], raw: true, transaction }),
    models.Tier.findAll({ where: { CollectiveId: from.id }, attributes: ['id', 'slug'], raw: true, transaction }),
  ]);

  const reslugs = getTierReslugPlan(sourceTiers, targetTiers);
  for (const { tierId, newSlug } of reslugs) {
    await models.Tier.update(
      { slug: newSlug },
      { where: { id: tierId }, fields: ['slug'], hooks: false, sideEffects: false, validate: false, transaction },
    );
  }

  return reslugs.map(
    ({ oldSlug, newSlug }) =>
      `The tier "${oldSlug}" of ${from.slug} was re-sluged to "${newSlug}" to avoid a slug collision on ${into.slug}`,
  );
};

/**
 * When moving members (`MemberCollectiveId`: from -> into), if the target is already a member of the same
 * collective with the same role/TierId, do not carry the source's entry over: group by `(CollectiveId, role, TierId)`
 * and keep only the groups where both accounts are present. Returns the source-side member ids to drop.
 */
const getMemberIdsToIgnore = async (
  from: Collective,
  into: Collective,
  transaction: SQLTransaction,
): Promise<number[]> => {
  const results = await models.Member.findAll({
    attributes: [
      [sequelize.literal(`ARRAY_AGG(DISTINCT "id") FILTER (WHERE "MemberCollectiveId" = ${Number(from.id)})`), 'ids'],
    ],
    where: { MemberCollectiveId: [from.id, into.id] },
    group: ['CollectiveId', 'role', 'TierId'],
    transaction,
    raw: true,
    having: sequelize.where(sequelize.fn('COUNT', sequelize.fn('DISTINCT', sequelize.col('MemberCollectiveId'))), {
      [Op.gt]: 1,
    }),
  });

  return flatten((results as unknown as { ids: number[] }[]).map(({ ids }) => ids)).filter(id => id !== null);
};

/**
 * When moving memberships (`CollectiveId`: from -> into), if the target already has the same member with the
 * same role/TierId, do not carry the source's entry over: group by `(MemberCollectiveId, role, TierId)` and keep
 * only the groups where both accounts are present. Returns the source-side membership ids to drop.
 */
const getMembershipIdsToIgnore = async (
  from: Collective,
  into: Collective,
  transaction: SQLTransaction,
): Promise<number[]> => {
  const results = await models.Member.findAll({
    attributes: [
      [sequelize.literal(`ARRAY_AGG(DISTINCT "id") FILTER (WHERE "CollectiveId" = ${Number(from.id)})`), 'ids'],
    ],
    where: { CollectiveId: [from.id, into.id] },
    group: ['MemberCollectiveId', 'role', 'TierId'],
    transaction,
    raw: true,
    having: sequelize.where(sequelize.fn('COUNT', sequelize.fn('DISTINCT', sequelize.col('CollectiveId'))), {
      [Op.gt]: 1,
    }),
  });

  return flatten((results as unknown as { ids: number[] }[]).map(({ ids }) => ids)).filter(id => id !== null);
};

// Defines the collective field names used in the DB. Useful to prevent typos in the config below
type CollectiveField =
  | 'CollectiveId'
  | 'HostCollectiveId'
  | 'ParentCollectiveId'
  | 'FromCollectiveId'
  | 'UsingGiftCardFromCollectiveId'
  | 'MemberCollectiveId';

type CollectiveFieldsConfig = Record<
  string,
  {
    model: ModelStatic<Model>;
    field: CollectiveField;
    getIdsToIgnore?: (from: Collective, into: Collective, sqlTransaction) => Promise<number[]>;
    fieldsToLog?: string[]; // For the migration log, defaults to ['id']
    /** Called before moving the entity's rows. Returns notes to surface in the merge summary (e.g. tier re-slugs) */
    onBeforeMove?: (from: Collective, into: Collective, sqlTransaction) => Promise<string[]>;
    /** Called with the duplicated ids right before they are destroyed (e.g. to re-point references to the surviving row) */
    onDuplicatesFound?: (from: Collective, into: Collective, idsToIgnore: number[], sqlTransaction) => Promise<void>;
    /** Returns a warning message surfaced in the merge summary when duplicated rows are deleted */
    getDuplicatesWarning?: (
      from: Collective,
      into: Collective,
      idsToIgnore: number[],
      sqlTransaction,
    ) => Promise<string>;
  }
>;

/**
 * A map of entities to migrate. The key must be a name given for these entities, and the value
 * must include a model, and a field where the old account ID will be replaced by the new one.
 */
const collectiveFieldsConfig: CollectiveFieldsConfig = {
  accountingCategories: {
    model: models.AccountingCategory,
    field: 'CollectiveId',
    getIdsToIgnore: getAccountingCategoriesToIgnore,
    onDuplicatesFound: rePointAccountingCategoryReferences,
    getDuplicatesWarning: getAccountingCategoriesDuplicatesWarning,
  },
  accountingCategoryRules: { model: models.AccountingCategoryRule, field: 'CollectiveId' },
  agreements: { model: models.Agreement, field: 'CollectiveId' },
  activities: { model: models.Activity, field: 'CollectiveId' },
  applications: { model: models.Application, field: 'CollectiveId' },
  childrenCollectives: { model: Collective, field: 'ParentCollectiveId' },
  comments: { model: models.Comment, field: 'CollectiveId' },
  commentsCreated: { model: models.Comment, field: 'FromCollectiveId' },
  connectedAccounts: { model: models.ConnectedAccount, field: 'CollectiveId' },
  conversations: { model: models.Conversation, field: 'CollectiveId' },
  conversationsCreated: { model: models.Conversation, field: 'FromCollectiveId' },
  creditTransactions: { model: models.Transaction, field: 'FromCollectiveId' },
  debitTransactions: { model: models.Transaction, field: 'CollectiveId' },
  emojiReactions: {
    model: models.EmojiReaction,
    field: 'FromCollectiveId',
    getIdsToIgnore: getEmojiReactionsToIgnore,
    getDuplicatesWarning: getEmojiReactionsDuplicatesWarning,
  },
  expenses: { model: models.Expense, field: 'CollectiveId' },
  expensesCreated: { model: models.Expense, field: 'FromCollectiveId' },
  giftCardTransactions: { model: models.Transaction, field: 'UsingGiftCardFromCollectiveId' },
  hostApplications: { model: models.HostApplication, field: 'HostCollectiveId' },
  hostApplicationsCreated: { model: models.HostApplication, field: 'CollectiveId' },
  hostedAgreements: { model: models.Agreement, field: 'HostCollectiveId' },
  hostedCollectives: { model: models.Collective, field: 'HostCollectiveId' },
  hostedPaypalProducts: { model: models.PaypalProduct, field: 'HostCollectiveId' },
  hostedVirtualCardRequests: { model: models.VirtualCardRequest, field: 'HostCollectiveId' },
  legalDocuments: { model: models.LegalDocument, field: 'CollectiveId', getIdsToIgnore: getLegalDocumentsToIgnore },
  location: { model: models.Location, field: 'CollectiveId' },
  memberInvitations: { model: models.MemberInvitation, field: 'MemberCollectiveId' },
  members: { model: models.Member, field: 'MemberCollectiveId', getIdsToIgnore: getMemberIdsToIgnore },
  membershipInvitations: { model: models.MemberInvitation, field: 'CollectiveId' },
  memberships: { model: models.Member, field: 'CollectiveId', getIdsToIgnore: getMembershipIdsToIgnore },
  notifications: {
    model: models.Notification,
    field: 'CollectiveId',
    getIdsToIgnore: getNotificationsToIgnore,
    getDuplicatesWarning: getNotificationsDuplicatesWarning,
  },
  ordersCreated: { model: models.Order, field: 'FromCollectiveId' },
  ordersReceived: { model: models.Order, field: 'CollectiveId' },
  paymentMethods: { model: models.PaymentMethod, field: 'CollectiveId' },
  payoutMethods: { model: models.PayoutMethod, field: 'CollectiveId' },
  paypalProducts: { model: models.PaypalProduct, field: 'CollectiveId' },
  personalTokens: { model: models.PersonalToken, field: 'CollectiveId' },
  requiredLegalDocuments: { model: models.RequiredLegalDocument, field: 'HostCollectiveId' },
  socialLinks: { model: models.SocialLink, field: 'CollectiveId', fieldsToLog: ['CollectiveId', 'type', 'url'] },
  tiers: { model: models.Tier, field: 'CollectiveId', onBeforeMove: reslugTiersOnCollision },
  updates: { model: models.Update, field: 'CollectiveId' },
  updatesCreated: { model: models.Update, field: 'FromCollectiveId' },
  virtualCards: { model: models.VirtualCard, field: 'CollectiveId' },
  virtualCardRequests: { model: models.VirtualCardRequest, field: 'CollectiveId' },
  virtualCardsHosted: { model: models.VirtualCard, field: 'HostCollectiveId' },
  recurringExpenses: { model: models.RecurringExpense, field: 'CollectiveId' },
  recurringExpensesCreated: { model: models.RecurringExpense, field: 'FromCollectiveId' },
  transactionsImports: { model: models.TransactionsImport, field: 'CollectiveId' },
};

// Defines the collective field names used in the DB. Useful to prevent typos in the config below
type UserField = 'UserId' | 'CreatedByUserId';

type UserFieldsConfig = Record<string, { model: User; field: UserField }>;

const userFieldsConfig = {
  agreements: { model: models.Agreement, field: 'UserId' },
  activities: { model: models.Activity, field: 'UserId' },
  applications: { model: models.Application, field: 'CreatedByUserId' },
  collectives: { model: models.Collective, field: 'CreatedByUserId' },
  comments: { model: models.Comment, field: 'CreatedByUserId' },
  conversationFollowers: { model: models.ConversationFollower, field: 'UserId' },
  conversations: { model: models.Conversation, field: 'CreatedByUserId' },
  emojiReactions: { model: models.EmojiReaction, field: 'UserId' },
  expenseAttachedFiles: { model: models.ExpenseAttachedFile, field: 'CreatedByUserId' },
  expenseItems: { model: models.ExpenseItem, field: 'CreatedByUserId' },
  expenses: { model: models.Expense, field: 'UserId' },
  memberInvitations: { model: models.MemberInvitation, field: 'CreatedByUserId' },
  members: { model: models.Member, field: 'CreatedByUserId' },
  migrationLogs: { model: models.MigrationLog, field: 'CreatedByUserId' },
  notifications: { model: models.Notification, field: 'UserId' },
  oAuthAuthorizationCodes: { model: models.OAuthAuthorizationCode, field: 'UserId' },
  orders: { model: models.Order, field: 'CreatedByUserId' },
  paymentMethods: { model: models.PaymentMethod, field: 'CreatedByUserId' },
  payoutMethods: { model: models.PayoutMethod, field: 'CreatedByUserId' },
  personalTokens: { model: models.PersonalToken, field: 'UserId' },
  transactions: { model: models.Transaction, field: 'CreatedByUserId' },
  twoFactorMethods: { model: models.UserTwoFactorMethod, field: 'UserId' },
  updates: { model: models.Update, field: 'CreatedByUserId' },
  userTokens: { model: models.UserToken, field: 'UserId' },
  uploadedFiles: { model: models.UploadedFile, field: 'CreatedByUserId' },
  virtualCards: { model: models.VirtualCard, field: 'UserId' },
  virtualCardRequests: { model: models.VirtualCardRequest, field: 'UserId' },
};

const mergeCollectiveFields = async (from, into, transaction) => {
  const fieldsToUpdate = {};
  const isTmpName = name => !name || name === DEFAULT_GUEST_NAME || name === 'Incognito';
  if (isTmpName(into.name) && !isTmpName(from.name)) {
    fieldsToUpdate['name'] = from.name;
  }

  if (from.countryISO && !into.countryISO) {
    fieldsToUpdate['countryISO'] = from.countryISO;
  }

  if (isEmpty(fieldsToUpdate)) {
    return into;
  }

  return into.update(fieldsToUpdate, {
    transaction,
    hooks: false,
    sideEffects: false,
    validate: false,
  });
};

const moveCollectiveAssociations = async (from, into, transaction) => {
  const summary = {};
  const warnings = [];

  for (const entity of Object.keys(collectiveFieldsConfig)) {
    const entityConfig = collectiveFieldsConfig[entity];
    const updateWhere = { [entityConfig.field]: from.id };
    let idsToIgnore = [];
    if (entityConfig.getIdsToIgnore) {
      idsToIgnore = await entityConfig.getIdsToIgnore(from, into, transaction);
      if (idsToIgnore.length) {
        updateWhere.id = { [Op.not]: idsToIgnore };
      }
    }

    if (entityConfig.onBeforeMove) {
      warnings.push(...(await entityConfig.onBeforeMove(from, into, transaction)));
    }

    // Special case for location, if a location exists for both the new and old collective, soft-delete the older one
    if (entity === 'location') {
      const intoLocation = await models.Location.findOne({
        where: { CollectiveId: into.id },
        attributes: ['updatedAt', 'id'],
        transaction,
      });
      const fromLocation = await models.Location.findOne({
        where: { CollectiveId: from.id },
        attributes: ['updatedAt', 'id'],
        transaction,
      });

      // If both exist, soft-delete the oldest one
      if (intoLocation && fromLocation) {
        const oldestLocation = fromLocation.updatedAt > intoLocation.updatedAt ? intoLocation : fromLocation;
        await oldestLocation.destroy({ transaction });
      }
    }

    // Similarly, for social links, if a link already exists for the same type and URL, just delete the old one
    else if (entity === 'socialLinks') {
      const isSameLink = (link1, link2) => link1.url === link2.url && link1.type === link2.type;
      const existingLinks = await models.SocialLink.findAll({
        where: { CollectiveId: into.id },
        transaction,
        raw: true,
      });
      const linksToIgnore = await models.SocialLink.findAll({
        where: { CollectiveId: from.id },
        transaction,
        raw: true,
      });

      const linksToDestroy = linksToIgnore.filter(linkToIgnore =>
        existingLinks.some(link => isSameLink(link, linkToIgnore)),
      );
      if (linksToDestroy.length) {
        await models.SocialLink.destroy({
          where: { CollectiveId: from.id, [Op.or]: linksToDestroy.map(l => ({ type: l.type, url: l.url })) },
          transaction,
        });
      }
    }

    try {
      const [, results] = await entityConfig.model.update(
        { [entityConfig.field]: into.id },
        {
          where: updateWhere,
          returning: entityConfig.fieldsToLog ?? ['id'],
          fields: [entityConfig.field],
          paranoid: false, // Also update soft-deleted entries
          transaction,
          // Ignore hooks and validations that could break the process
          hooks: false,
          sideEffects: false,
          validate: false,
        },
      );

      if (!entityConfig.fieldsToLog) {
        summary[entity] = (results as unknown as { id: number | string }[]).map(r => r.id);
      } else {
        summary[entity] = results;
      }

      if (idsToIgnore.length) {
        summary[`${entity}-deleted`] = idsToIgnore;
        if (entityConfig.onDuplicatesFound) {
          await entityConfig.onDuplicatesFound(from, into, idsToIgnore, transaction);
        }
        if (entityConfig.getDuplicatesWarning) {
          warnings.push(await entityConfig.getDuplicatesWarning(from, into, idsToIgnore, transaction));
        }
        await entityConfig.model.destroy({
          where: { [entityConfig.field]: from.id, id: idsToIgnore },
          transaction,
          hooks: false,
          sideEffects: false,
          validate: false,
        } as DestroyOptions);
      }
    } catch (e) {
      if (
        e.name === 'SequelizeUniqueConstraintError' &&
        (entityConfig.model === models.LegalDocument || entityConfig.model === models.SocialLink)
      ) {
        // It's fine if the target profile already has a legal document set for this type/year, just delete the other one
        warnings.push(
          `A legal document for ${from.slug} could not be transferred as one already exists for the same year/type with ${into.slug}`,
        );
      } else {
        throw new Error(
          `Error moving ${entity} from ${from.slug} to ${into.slug}: ${e.message} (${safeJsonStringify(updateWhere)})`,
        );
      }
    }
  }

  return { summary, warnings };
};

type MergeUsersSummary = Record<keyof UserFieldsConfig, number[]>;

const mergeUsers = async (fromUser, toUser, transaction): Promise<MergeUsersSummary> => {
  const summary = {};

  // Move all `UserId`/`CreatedByUserId` fields
  for (const entity of Object.keys(userFieldsConfig)) {
    const entityConfig = userFieldsConfig[entity];
    const [, results] = await entityConfig.model.update(
      { [entityConfig.field]: toUser.id },
      {
        where: { [entityConfig.field]: fromUser.id },
        returning: ['id'],
        fields: [entityConfig.field],
        transaction,
        paranoid: false, // Also update soft-deleted entries
        // Ignore hooks and validations that could break the process
        hooks: false,
        sideEffects: false,
        validate: false,
      },
    );

    summary[entity] = results.map(r => r.id);
  }

  // Mark fromUser as deleted
  const newUserData = { ...(fromUser.data || {}), mergedIntoUserId: toUser.id };
  await fromUser.update({ data: newUserData }, { transaction, hooks: false });
  await fromUser.destroy({ transaction, hooks: false });
  return summary;
};

/**
 * An helper to merge a collective with another one, with some limitations.
 * @returns an array of warning messages
 */
export const mergeAccounts = async (
  from: Collective,
  into: Collective,
  userId: number | null = null,
): Promise<string[]> => {
  // Make sure all conditions are met before we start
  checkMergeCollective(from, into);

  // When moving users, we'll also update the user entries
  let fromUser, toUser;
  if (from.type === CollectiveType.USER && !from.isIncognito) {
    fromUser = await models.User.findOne({ where: { CollectiveId: from.id } });
    toUser = await models.User.findOne({ where: { CollectiveId: into.id } });
    if (!fromUser || !toUser) {
      throw new Error('Cannot find one of the user entries to merge');
    }
  }

  // Trigger the merge in a transaction
  return sequelize.transaction(async transaction => {
    // Update collective
    await mergeCollectiveFields(from, into, transaction);

    // Update all related models
    const changesSummary = { fromAccount: from.id, intoAccount: into.id };
    const mergeAccountAssociationsResult = await moveCollectiveAssociations(from, into, transaction);
    const warnings = mergeAccountAssociationsResult.warnings;
    changesSummary['associations'] = mergeAccountAssociationsResult.summary;

    // Moving transactions makes the balance materialized views stale for both accounts
    const movedAssociations = mergeAccountAssociationsResult.summary;
    const hasMovedTransactions = ['creditTransactions', 'debitTransactions', 'giftCardTransactions'].some(
      entity => (movedAssociations[entity] || []).length > 0,
    );
    if (hasMovedTransactions) {
      warnings.push(getStaleBalancesWarning(from, into));
    }

    // Merge user entries
    if (fromUser) {
      // Move all `UserId`/`CreatedByUserId` fields
      changesSummary['fromUser'] = fromUser.id;
      changesSummary['intoUser'] = toUser.id;
      changesSummary['userChanges'] = await mergeUsers(fromUser, toUser, transaction);
    }

    // Mark from profile as deleted
    const collectiveData = { ...(from.data || {}), mergedIntoCollectiveId: into.id };
    await models.Collective.update(
      { deletedAt: new Date(), slug: `${from.slug}-merged`, data: collectiveData },
      { where: { id: from.id }, transaction },
    );

    // Log everything
    await models.MigrationLog.create(
      {
        type: MigrationLogType.MERGE_ACCOUNTS,
        description: `Merge ${from.slug} into ${into.slug}`,
        CreatedByUserId: userId,
        data: changesSummary,
      },
      { transaction },
    );

    return warnings;
  });
};
