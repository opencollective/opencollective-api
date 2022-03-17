import { flatten, isEmpty, keyBy, mapValues, some } from 'lodash';

import { types as CollectiveTypes } from '../constants/collectives';
import models, { Op, sequelize } from '../models';
import { MigrationLogType } from '../models/MigrationLog';

import { DEFAULT_GUEST_NAME } from './guest-accounts';

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
  fromCollective: typeof models.Collective,
): Promise<{
  account: Record<keyof CollectiveFieldsConfig, number>;
  user: Record<keyof UserFieldsConfig, number>;
}> => {
  if (fromCollective.type === CollectiveTypes.USER && !fromCollective.isIncognito) {
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

const checkMergeCollective = (from: typeof models.Collective, into: typeof models.Collective): void => {
  if (!from || !into) {
    throw new Error('Cannot merge profiles, one of them does not exist');
  } else if (from.type !== into.type) {
    throw new Error('Cannot merge accounts with different types');
  } else if (from.id === into.id) {
    throw new Error('Cannot merge an account into itself');
  } else if (from.id === into.ParentCollectiveId) {
    throw new Error('You can not merge an account with its parent');
  } else if (from.id === into.HostCollectiveId) {
    throw new Error('You can not merge an account with its host');
  }
};

/**
 * Simulate the `mergeAccounts` function. Returns a summary of the changes as a string
 */
export const simulateMergeAccounts = async (
  from: typeof models.Collective,
  into: typeof models.Collective,
): Promise<string> => {
  // Detect errors that would completely block the process (throws)
  checkMergeCollective(from, into);

  // Generate a summary of the changes
  const movedItemsCounts = await getMovableItemsCounts(from);
  let summary = 'The profiles information will be merged.\n\n';

  const addLineToSummary = str => {
    summary += `${str}\n`;
  };

  const addCountsToSummary = counts => {
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

  return summary;
};

/** Legal documents have a unique key on CollectiveId/type/year. We need to ignore the ones that already exist */
const getLegalDocumentsToIgnore = async (from, into, transaction): Promise<number[]> => {
  const results = await models.LegalDocument.findAll({
    attributes: [[sequelize.fn('ARRAY_AGG', sequelize.col('id')), 'ids']],
    where: { CollectiveId: [from.id, into.id] },
    group: ['documentType', 'year'],
    transaction,
    raw: true,
    having: sequelize.where(sequelize.fn('COUNT', sequelize.col('id')), { [Op.gt]: 1 }),
  });

  return flatten(results.map(({ ids }) => ids));
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
    model: typeof models.Collective;
    field: CollectiveField;
    getIdsToIgnore?: (
      from: typeof models.Collective,
      into: typeof models.Collective,
      sqlTransaction,
    ) => Promise<number[]>;
  }
>;

/**
 * A map of entities to migrate. The key must be a name given for these entities, and the value
 * must include a model, and a field where the old account ID will be replaced by the new one.
 */
const collectiveFieldsConfig: CollectiveFieldsConfig = {
  activities: { model: models.Activity, field: 'CollectiveId' },
  applications: { model: models.Application, field: 'CollectiveId' },
  childrenCollectives: { model: models.Collective, field: 'ParentCollectiveId' },
  comments: { model: models.Comment, field: 'CollectiveId' },
  commentsCreated: { model: models.Comment, field: 'FromCollectiveId' },
  connectedAccounts: { model: models.ConnectedAccount, field: 'CollectiveId' },
  conversations: { model: models.Conversation, field: 'CollectiveId' },
  conversationsCreated: { model: models.Conversation, field: 'FromCollectiveId' },
  creditTransactions: { model: models.Transaction, field: 'FromCollectiveId' },
  debitTransactions: { model: models.Transaction, field: 'CollectiveId' },
  emojiReactions: { model: models.EmojiReaction, field: 'FromCollectiveId' },
  expenses: { model: models.Expense, field: 'CollectiveId' },
  expensesCreated: { model: models.Expense, field: 'FromCollectiveId' },
  giftCardTransactions: { model: models.Transaction, field: 'UsingGiftCardFromCollectiveId' },
  hostApplications: { model: models.HostApplication, field: 'HostCollectiveId' },
  hostApplicationsCreated: { model: models.HostApplication, field: 'CollectiveId' },
  hostedCollectives: { model: models.Collective, field: 'HostCollectiveId' },
  legalDocuments: { model: models.LegalDocument, field: 'CollectiveId', getIdsToIgnore: getLegalDocumentsToIgnore },
  memberInvitations: { model: models.MemberInvitation, field: 'MemberCollectiveId' },
  members: { model: models.Member, field: 'MemberCollectiveId' },
  membershipInvitations: { model: models.MemberInvitation, field: 'CollectiveId' },
  memberships: { model: models.Member, field: 'CollectiveId' },
  notifications: { model: models.Notification, field: 'CollectiveId' },
  ordersCreated: { model: models.Order, field: 'FromCollectiveId' },
  ordersReceived: { model: models.Order, field: 'CollectiveId' },
  paymentMethods: { model: models.PaymentMethod, field: 'CollectiveId' },
  payoutMethods: { model: models.PayoutMethod, field: 'CollectiveId' },
  paypalProducts: { model: models.PaypalProduct, field: 'CollectiveId' },
  requiredLegalDocuments: { model: models.RequiredLegalDocument, field: 'HostCollectiveId' },
  tiers: { model: models.Tier, field: 'CollectiveId' },
  updates: { model: models.Update, field: 'CollectiveId' },
  updatesCreated: { model: models.Update, field: 'FromCollectiveId' },
  virtualCards: { model: models.VirtualCard, field: 'CollectiveId' },
  virtualCardsHosted: { model: models.VirtualCard, field: 'HostCollectiveId' },
  recurringExpenses: { model: models.RecurringExpense, field: 'CollectiveId' },
};

// Defines the collective field names used in the DB. Useful to prevent typos in the config below
type UserField = 'UserId' | 'CreatedByUserId';

type UserFieldsConfig = Record<string, { model: typeof models.User; field: UserField }>;

const userFieldsConfig = {
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
  orders: { model: models.Order, field: 'CreatedByUserId' },
  paymentMethods: { model: models.PaymentMethod, field: 'CreatedByUserId' },
  payoutMethods: { model: models.PayoutMethod, field: 'CreatedByUserId' },
  transactions: { model: models.Transaction, field: 'CreatedByUserId' },
  updates: { model: models.Update, field: 'CreatedByUserId' },
  virtualCards: { model: models.VirtualCard, field: 'UserId' },
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

  if (from.address && !into.address) {
    fieldsToUpdate['address'] = from.address;
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

    try {
      const [, results] = await entityConfig.model.update(
        { [entityConfig.field]: into.id },
        {
          where: updateWhere,
          returning: ['id'],
          fields: [entityConfig.field],
          paranoid: false, // Also update soft-deleted entries
          transaction,
          // Ignore hooks and validations that could break the process
          hooks: false,
          sideEffects: false,
          validate: false,
        },
      );

      summary[entity] = results.map(r => r.id);

      if (idsToIgnore.length) {
        summary[`${entity}-deleted`] = idsToIgnore;
        await entityConfig.model.destroy({
          where: { [entityConfig.field]: from.id, id: idsToIgnore },
          transaction,
          hooks: false,
          sideEffects: false,
          validate: false,
        });
      }
    } catch (e) {
      if (e.name === 'SequelizeUniqueConstraintError' && entityConfig.model === models.LegalDocument) {
        // It's fine if the target profile already has a legal document set for this type/year, just delete the other one
        warnings.push(
          `A legal document for ${from.slug} could not be transferred as one already exists for the same year/type with ${into.slug}`,
        );
      } else {
        throw e;
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
  from: typeof models.Collective,
  into: typeof models.Collective,
  userId: number | null = null,
): Promise<string[]> => {
  // Make sure all conditions are met before we start
  checkMergeCollective(from, into);

  // When moving users, we'll also update the user entries
  let fromUser, toUser;
  if (from.type === CollectiveTypes.USER && !from.isIncognito) {
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
      { deletedAt: Date.now(), slug: `${from.slug}-merged`, data: collectiveData },
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
